import { statSync } from 'node:fs'

import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import type { HostProfile, Instance, LoaderKind } from '../instance.js'
import type { ContentSource, DependencyResolver } from '../sources.js'
import { closureToFindings, computeClosure } from '../deps/closure.js'
import type { ClosureResult } from '../deps/closure.js'
import { buildRepairPlan } from '../deps/plan.js'
import type { RepairPlan } from '../deps/plan.js'
import { checkLocalInstance } from './local.js'
import { scanInstanceDir } from '../instance/scan.js'
import type { ScannedMod } from '../instance/scan.js'
import { readPackFile } from './read-pack.js'
import { checkInstance, checkJava } from './check.js'
import { verdictOf } from './types.js'
import type { Finding, PreflightReport } from './types.js'

export interface PreflightOptions {
  /** `.mrpack` 文件，或一个实例目录（MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录） */
  readonly target: string
  /** 内容源。若同时实现 DependencyResolver，预检会做递归依赖闭包。 */
  readonly source: ContentSource & Partial<DependencyResolver>
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
        yield Op.log('info', pack.kind === 'curseforge' ? 'modpack.curseforge' : 'modpack.parsed', {
          name: instance.name,
          gameVersion: instance.gameVersion,
          loader: instance.loader,
          mods: instance.mods.length,
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
    let plan: RepairPlan = EMPTY_PLAN
    let mods = instance.mods.length
    let resolved = 0
    let unresolved = 0

    // Java 与在线/离线无关，三条链路都要跑。
    if (opts.host !== undefined) {
      findings.push(...checkJava(instance, opts.host))
    }

    if (isDir) {
      // ---- 离线模式：只有 jar 内的 modId，没有 projectId ----
      findings.push(
        ...checkLocalInstance(
          { instance, mods: localMods, skipped: skippedJars },
          {
            gameVersion: instance.gameVersion,
            loaderVersion: instance.loader.version,
          },
        ),
      )
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
        code: 'CF_API_REQUIRED',
        message: `整合包声明了 ${instance.mods.length} 个 CurseForge 文件，但没有 API key 无法解析名称与兼容性`,
        hint: '到 console.curseforge.com 申请 key 后才能做 mod 级校验；Java 与加载器版本仍然可参考',
      })
    } else {
      // ---- 在线模式：有 projectId，可以查元数据和递归闭包 ----
      const withVersion = instance.mods
        .map((m) => m.versionId)
        .filter((id): id is string => id !== undefined)
      const ids = [...new Set(withVersion)]

      yield Op.progress('metadata.fetch', 0, ids.length, '拉取模组元数据')
      const versions = ids.length === 0 ? [] : await opts.source.getVersions(ids, signal)
      yield Op.progress('metadata.fetch', ids.length, ids.length, '拉取模组元数据')

      if (signal.aborted) return

      const map = new Map(versions.map((v) => [v.versionId, v]))
      const knownVersions = [...map.values()]

      findings.push(...checkInstance({ instance, versions: map }))

      const resolveFn = opts.source.resolve
      let closure: ClosureResult | null = null
      if (typeof resolveFn === 'function') {
        yield Op.log('info', 'deps.closure.start', { roots: knownVersions.length })
        closure = await computeClosure({
          roots: knownVersions,
          filter: {
            gameVersion: instance.gameVersion,
            loader: instance.loader.kind === 'vanilla' ? null : instance.loader.kind,
          },
          resolver: { resolve: resolveFn.bind(opts.source) },
          signal,
        })
        findings.push(...closureToFindings(closure))
        yield Op.log('info', 'deps.closure.done', {
          visited: closure.visited.length,
          missing: closure.missing.length,
          cycles: closure.cycles.length,
          truncated: closure.truncated,
        })
      } else {
        yield Op.log('warn', 'deps.closure.skipped', { reason: 'source cannot resolve by projectId' })
      }

      plan = closure === null ? EMPTY_PLAN : buildRepairPlan(closure)
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
      plan,
      generatedAt: new Date().toISOString(),
    }

    yield Op.result(report)
    yield Op.done()
  })
}
