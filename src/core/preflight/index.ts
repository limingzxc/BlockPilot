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
import { checkLocalDeps } from '../deps/localDeps.js'
import { scanInstanceDir } from '../instance/scan.js'
import type { ScannedMod } from '../instance/scan.js'
import { mrpackToInstance, readMrpackIndex } from './mrpack.js'
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
        const index = readMrpackIndex(opts.target)
        instance = mrpackToInstance(index)
      } catch (err) {
        yield Op.failed('BAD_MODPACK', `无法解析整合包：${String(err)}`, '目前支持 .mrpack 和实例目录')
        return
      }
      yield Op.log('info', 'modpack.parsed', {
        name: instance.name,
        gameVersion: instance.gameVersion,
        loader: instance.loader,
        mods: instance.mods.length,
      })
    }

    if (signal.aborted) return

    const findings: Finding[] = []
    let plan: RepairPlan = EMPTY_PLAN
    let mods = instance.mods.length
    let resolved = 0
    let unresolved = 0

    // Java 与在线/离线无关，两条链路都要跑。
    if (opts.host !== undefined) {
      findings.push(...checkJava(instance, opts.host))
    }

    if (isDir) {
      // ---- 离线模式：只有 jar 内的 modId，没有 projectId ----
      const issues = checkLocalDeps(
        localMods.map((m) => ({
          modId: m.meta.modId,
          dependencies: m.meta.dependencies,
          provides: m.meta.provides,
        })),
      )
      for (const issue of issues) {
        findings.push({
          severity: 'blocker',
          code: 'MISSING_DEPENDENCY',
          message: `${issue.requiredBy.join('、')} 需要前置模组 ${issue.modId}，本地目录里没有`,
          subject: issue.modId,
          hint: '本地元数据只提供 modId，没有下载地址；需要联网反查才能给出可安装版本',
        })
      }
      if (skippedJars.length > 0) {
        findings.push({
          severity: 'info',
          code: 'UNREADABLE_JAR',
          message: `${skippedJars.length} 个 jar 读不出模组元数据，未参与检查`,
          hint: skippedJars.slice(0, 5).join('、') + (skippedJars.length > 5 ? ' 等' : ''),
        })
      }
      if (instance.gameVersion === 'unknown') {
        findings.push({
          severity: 'warning',
          code: 'UNKNOWN_GAME_VERSION',
          message: '目录里没有版本信息，无法校验 MC 版本与 Java',
          hint: 'Prism/MultiMC 实例的 mmc-pack.json 可提供；否则需要显式指定',
        })
      }
      mods = localMods.length + skippedJars.length
      resolved = localMods.length
      unresolved = skippedJars.length
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
