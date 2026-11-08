import { statSync } from 'node:fs'

import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import type { HostProfile, Instance, LoaderKind } from '../instance.js'
import { NetworkError } from '../http.js'
import type { ContentSource, DependencyResolver, ProjectNamer, VersionInfo } from '../sources.js'
import { closureToFindings, computeClosure } from '../deps/closure.js'
import type { ClosureResult } from '../deps/closure.js'
import { buildRepairPlan } from '../deps/plan.js'
import type { RepairPlan } from '../deps/plan.js'
import { checkLocalInstance } from './local.js'
import { checkAssets } from './assets.js'
import { scanInstanceDir } from '../instance/scan.js'
import type { ScannedMod } from '../instance/scan.js'
import { readPackFile } from './read-pack.js'
import { checkInstance, checkJava } from './check.js'
import type { JavaRequirement } from './check.js'
import { depKey } from '../modmeta/types.js'
import { verdictOf } from './types.js'
import type { Finding, PreflightReport } from './types.js'

/**
 * 从 jar 元数据里收集模组自己声明的 Java 范围。
 *
 * 只认 Fabric/Quilt 的 `depends.java`（Forge 的 mods.toml 没有这个字段，
 * 它用 javafml + loaderVersion 表达类似约束）。没写范围的不算。
 */
function javaRequirements(mods: readonly ScannedMod[]): JavaRequirement[] {
  const out: JavaRequirement[] = []
  for (const m of mods) {
    for (const dep of m.meta.dependencies) {
      if (depKey(dep.modId) !== 'java' || dep.versionRange === undefined) continue
      out.push({ modId: m.meta.modId, range: dep.versionRange })
    }
  }
  return out
}

export interface PreflightOptions {
  /** `.mrpack` 文件，或一个实例目录（MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录） */
  readonly target: string
  /** 内容源。若同时实现 DependencyResolver，预检会做递归依赖闭包。 */
  readonly source: ContentSource & Partial<DependencyResolver> & Partial<ProjectNamer>
  readonly host?: HostProfile
  /** 扫描目录时，目录内没有版本信息则用这个兜底 */
  readonly fallback?: {
    readonly gameVersion: string
    readonly loader: { readonly kind: LoaderKind; readonly version: string }
  }
}

const EMPTY_PLAN: RepairPlan = { installs: [], manual: [] }

export function createPreflight(opts: PreflightOptions): Operation<PreflightReport> {
  return defineOperation<PreflightReport>('preflight', async function* (signal) {
    let isDir: boolean
    try {
      isDir = statSync(opts.target).isDirectory()
    } catch {
      yield Op.failed('TARGET_NOT_FOUND', `找不到目标：${opts.target}`)
      return
    }

    let instance: Instance
    let localMods: ScannedMod[] = []
    let skippedJars: string[] = []
    let corruptJars: string[] = []
    let overridesMods = 0
    /** CurseForge 包没有 API key 时，mod 级校验整个跳过 */
    let cfGated = false

    if (isDir) {
      const scan = scanInstanceDir(opts.target, {
        fallbackGameVersion: opts.fallback?.gameVersion ?? 'unknown',
        fallbackLoader: opts.fallback?.loader ?? { kind: 'vanilla', version: 'unknown' },
      })
      instance = scan.instance
      localMods = [...scan.mods]
      skippedJars = [...scan.skipped]
      corruptJars = [...scan.corrupt]
      yield Op.log('info', 'instance.scanned', {
        dir: opts.target,
        gameVersion: instance.gameVersion,
        loader: instance.loader,
        mods: localMods.length,
        skipped: skippedJars.length,
      })
    } else {
      yield Op.log('info', 'modpack.reading', { path: opts.target })
      try {
        const pack = readPackFile(opts.target)
        instance = pack.instance
        // CF 的 files 只有 projectID/fileID，下载与校验都要 API key。
        // 能力声明由 readPackFile 一处给出，消费者不再各自判断格式
        cfGated = !pack.ability.checksMods
        overridesMods = pack.overridesMods
        yield Op.log('info', pack.kind === 'curseforge' ? 'modpack.curseforge' : 'modpack.parsed', {
          name: instance.name,
          gameVersion: instance.gameVersion,
          loader: instance.loader,
          mods: instance.mods.length,
          overridesMods,
        })
      } catch (err) {
        yield Op.failed(
          'BAD_MODPACK',
          String(err instanceof Error ? err.message : err),
          '目前支持 .mrpack、CurseForge 的 .zip（带 manifest.json）和实例目录',
        )
        return
      }
    }

    if (signal.aborted) return

    const findings: Finding[] = []
    // overrides 里的 jar 不属于「清单」，但解压后确实会进 mods/。
    // 不说明的话，用户会拿「mods 271」去对数，然后发现游戏里加载了 304 个（issue #13）
    if (overridesMods > 0) {
      findings.push({
        severity: 'info',
        code: 'PACK_BUILTIN_MODS',
        message:
          `overrides/mods 里还有 ${overridesMods} 个 jar，` +
          `解压后实例里共 ${instance.mods.length + overridesMods} 个模组`,
        hint: '这些文件不需要 API key；装完后对实例目录跑 preflight，它们会一起参与校验',
      })
    }
    let plan: RepairPlan = EMPTY_PLAN
    let mods = instance.mods.length
    let resolved = 0
    let unresolved = 0

    // Java 与在线/离线无关，三条链路都要跑。
    // 离线模式能读到 jar 里的 `java` 依赖，那份声明比「MC 版本 → Java」的兜底表准（issue #11）。
    if (opts.host !== undefined) {
      findings.push(...checkJava(instance, opts.host, isDir ? javaRequirements(localMods) : []))
    }

    if (isDir) {
      // ---- 离线模式：只有 jar 内的 modId，没有 projectId ----
      findings.push(
        ...checkLocalInstance(
          { instance, mods: localMods, skipped: skippedJars, corrupt: corruptJars },
          {
            gameVersion: instance.gameVersion,
            loaderVersion: instance.loader.version,
          },
        ),
      )
      // 资源包不在 mods 里，但缺了同样起不来——单独查一层（issue #2）
      findings.push(...checkAssets(opts.target, instance.gameVersion))
      mods = localMods.length + skippedJars.length
      resolved = localMods.length
      unresolved = skippedJars.length
    } else if (cfGated) {
      // ---- CurseForge 模式：没有 key，mod 级校验整个做不了 ----
      // 把 N 个文件全算成 unresolved，verdict 自然落到 unknown——
      // 这正是契约里「有东西没校验过，结论不可信」的那一档
      unresolved = instance.mods.length
      findings.push({
        severity: 'warning',
        code: 'CF_NO_MOD_CHECK',
        message: `整合包声明了 ${instance.mods.length} 个 CurseForge 文件；预检这一步不做 mod 级校验`,
        hint:
          '装的时候不需要 key（没 key 会自动走 MCIM 镜像逐个解析）。' +
          '想在预检里也查每个 mod 的版本/依赖，才需要 BLOCKPILOT_CF_API_KEY；' +
          'Java 与加载器版本这里仍然可参考',
      })
    } else {
      // ---- 在线模式：有 projectId，可以查元数据和递归闭包 ----
      const withVersion = instance.mods
        .map((m) => m.versionId)
        .filter((id): id is string => id !== undefined)
      const ids = [...new Set(withVersion)]

      yield Op.progress('metadata.fetch', 0, ids.length, '拉取模组元数据')
      let versions: readonly VersionInfo[]
      try {
        versions = ids.length === 0 ? [] : await opts.source.getVersions(ids, signal)
      } catch (err) {
        // 断网不是「这些模组没有元数据」。分开报，用户才知道该修网络还是修包。
        if (err instanceof NetworkError) {
          yield Op.failed('NETWORK_ERROR', err.message, '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理')
          return
        }
        throw err
      }
      yield Op.progress('metadata.fetch', ids.length, ids.length, '拉取模组元数据')

      if (signal.aborted) return

      const map = new Map(versions.map((v) => [v.versionId, v]))
      const knownVersions = [...map.values()]

      findings.push(...checkInstance({ instance, versions: map }))

      const resolveFn = opts.source.resolve
      let closure: ClosureResult | null = null
      let nameOf: ((projectId: string) => string | undefined) | undefined
      if (typeof resolveFn === 'function') {
        yield Op.log('info', 'deps.closure.start', { roots: knownVersions.length })
        try {
          closure = await computeClosure({
            roots: knownVersions,
            filter: {
              gameVersion: instance.gameVersion,
              loader: instance.loader.kind === 'vanilla' ? null : instance.loader.kind,
            },
            resolver: { resolve: resolveFn.bind(opts.source) },
            signal,
          })
        } catch (err) {
          if (err instanceof NetworkError) {
            yield Op.failed('NETWORK_ERROR', err.message, '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理')
            return
          }
          throw err
        }
        // 整合包里没有 jar，依赖到底在不在无法证实——见 FindingOptions 的注释。
        // 宁可降级成 warning，也不要把「没看见」说成「不存在」。
        // 缺的依赖只有 projectId，顺手查一次项目名：只影响文案，查不到照旧用 id。
        if (closure.missing.length > 0) {
          const fromVersions = new Map(knownVersions.map((v) => [v.projectId, v.name]))
          // 缺失的依赖，以及「是谁需要它」——后者也只有 id。元数据里的 name 是
          // 版本名（可能就叫 "0.2.0"），项目标题才认得出来，所以一并查。
          const ids = [
            ...new Set([
              ...closure.missing.map((m) => m.projectId),
              ...closure.missing.flatMap((m) => m.requiredBy),
            ]),
          ]
          let projectNames: ReadonlyMap<string, string> = new Map()
          if (typeof opts.source.getProjectNames === 'function') {
            try {
              projectNames = await opts.source.getProjectNames(ids, signal)
            } catch {
              // 名字是锦上添花，拿不到不影响判定
            }
          }
          nameOf = (projectId) => projectNames.get(projectId) ?? fromVersions.get(projectId)
        }
        findings.push(
          ...closureToFindings(closure, {
            verified: false,
            ...(nameOf === undefined ? {} : { nameOf }),
          }),
        )
        yield Op.log('info', 'deps.closure.done', {
          visited: closure.visited.length,
          missing: closure.missing.length,
          cycles: closure.cycles.length,
          truncated: closure.truncated,
        })
      } else {
        yield Op.log('warn', 'deps.closure.skipped', { reason: 'source cannot resolve by projectId' })
      }

      plan =
        closure === null
          ? EMPTY_PLAN
          : buildRepairPlan(closure, {
              verified: false,
              ...(nameOf === undefined ? {} : { nameOf }),
            })
      mods = instance.mods.length
      resolved = map.size
      // map 里没有的，就是没查到的——本地文件和坏 id 都在里面，不要重复计。
      unresolved = instance.mods.length - map.size
    }

    if (signal.aborted) return

    const base = verdictOf(findings)
    // 有东西没校验过时，"ok" 是不可信的结论。
    const verdict = base === 'ok' && unresolved > 0 ? 'unknown' : base

    const report: PreflightReport = {
      verdict,
      findings,
      stats: { mods, resolved, unresolved },
      target: { gameVersion: instance.gameVersion, loader: instance.loader },
      plan,
      generatedAt: new Date().toISOString(),
    }

    yield Op.result(report)
    yield Op.done()
  })
}
