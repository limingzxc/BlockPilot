import { statSync } from 'node:fs'
import type { CfFileInfo, CurseforgeLike } from '../curseforge.js'
import { CurseforgeError, cfFileToVersionInfo, unconfiguredCurseforge } from '../curseforge.js'
import type { ClosureResult } from '../deps/closure.js'
import { closureToFindings, computeClosure } from '../deps/closure.js'
import type { RepairPlan } from '../deps/plan.js'
import { buildRepairPlan, EMPTY_PLAN } from '../deps/plan.js'
import { errMessage } from '../errors.js'
import { Op } from '../events.js'
import { NetworkError } from '../http.js'
import { scanInstanceDir } from '../instance/scan.js'
import type { HostProfile, LoaderKind } from '../instance.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import type { ContentSource, DependencyResolver, ProjectNamer, VersionInfo } from '../sources.js'
import { cfDependencyFindings } from './cf-deps.js'
import { checkInstance, checkJava } from './check.js'
import type { CurseforgeManifest } from './curseforge.js'
import type { PackFileRead } from './read-pack.js'
import { readPackFile } from './read-pack.js'
import type { ReportStats } from './report.js'
import { assembleReport, preflightDir } from './report.js'
import type { Finding, PreflightReport } from './types.js'

export interface PreflightOptions {
  /** `.mrpack` 文件，或一个实例目录（MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录） */
  readonly target: string
  /** 内容源。若同时实现 DependencyResolver，预检会做递归依赖闭包。 */
  readonly source: ContentSource & Partial<DependencyResolver> & Partial<ProjectNamer>
  /**
   * CurseForge 解析器。缺省按「有 key 走官方、没有走镜像」自动选。
   * 测试注入假实现就能离线验证 CF 的 mod 级校验。
   */
  readonly curseforge?: CurseforgeLike
  readonly host?: HostProfile
  /** 版本 JSON 的 Java 需求；缺省按 gameVersion 查表 */
  readonly javaMajor?: number
  /** 扫描目录时，目录内没有版本信息则用这个兜底 */
  readonly fallback?: {
    readonly gameVersion: string
    readonly loader: { readonly kind: LoaderKind; readonly version: string }
  }
}

export function createPreflight(opts: PreflightOptions): Operation<PreflightReport> {
  return defineOperation<PreflightReport>('preflight', async function* (signal) {
    let isDir: boolean
    try {
      isDir = statSync(opts.target).isDirectory()
    } catch {
      yield Op.failed('TARGET_NOT_FOUND', `找不到目标：${opts.target}`)
      return
    }

    /**
     * ---- 目录：Java / 本地依赖 / assets 一次查完 ----
     *
     * 装配交给 `report.ts`：deploy 的部署后自检走同一个 module，
     * 两边不可能再给出不同结论。
     */
    if (isDir) {
      const scan = scanInstanceDir(opts.target, {
        fallbackGameVersion: opts.fallback?.gameVersion ?? 'unknown',
        fallbackLoader: opts.fallback?.loader ?? { kind: 'vanilla', version: 'unknown' },
      })
      yield Op.log('info', 'instance.scanned', {
        dir: opts.target,
        gameVersion: scan.instance.gameVersion,
        loader: scan.instance.loader,
        mods: scan.mods.length,
        skipped: scan.skipped.length,
      })

      if (signal.aborted) return
      yield Op.result(
        preflightDir({
          dir: opts.target,
          scan,
          ...(opts.host === undefined ? {} : { host: opts.host }),
          ...(opts.javaMajor === undefined ? {} : { javaMajor: opts.javaMajor }),
        }),
      )
      yield Op.done()
      return
    }

    /**
     * ---- 整合包：包里没有 jar，只有清单 ----
     *
     * 下面两个分支的区别只在「元数据从哪来」，装配是同一份。
     */
    let pack: PackFileRead
    yield Op.log('info', 'modpack.reading', { path: opts.target })
    try {
      pack = readPackFile(opts.target)
    } catch (err) {
      yield Op.failed(
        'BAD_MODPACK',
        errMessage(err),
        '目前支持 .mrpack、CurseForge 的 .zip（带 manifest.json）和实例目录',
      )
      return
    }

    const instance = pack.instance
    // CF 的 files 只有 projectID/fileID，下载与校验都要 API key。
    // 能力声明由 readPackFile 一处给出，消费者不再各自判断格式
    const cfGated = !pack.ability.checksMods
    // overrides 里的 jar 不属于「清单」，但解压后确实会进 mods/
    const overridesMods = pack.overridesMods
    const cfManifest: CurseforgeManifest | undefined =
      pack.kind === 'curseforge' ? pack.curseforgeManifest : undefined

    yield Op.log('info', pack.kind === 'curseforge' ? 'modpack.curseforge' : 'modpack.parsed', {
      name: instance.name,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      mods: instance.mods.length,
      overridesMods,
    })

    if (signal.aborted) return

    const findings: Finding[] = []
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
    // 三条链路的缺省值相同：清单里的每一项都还没校验过
    let stats: ReportStats = { mods: instance.mods.length, resolved: 0, unresolved: 0 }

    // Java 与在线/离线无关。包里没有 jar，所以没有模组自己声明的 Java 范围可用
    if (opts.host !== undefined) {
      findings.push(...checkJava(instance, opts.host))
    }

    if (cfGated) {
      /**
       * ---- CurseForge：补上 mod 级校验 ----
       *
       * 文件元数据可以免 key 拿到（镜像），所以能判版本、判加载器、判声明依赖——
       * 判不了的（拿不到元数据的文件）仍然算 unresolved，verdict 落到 unknown，
       * 不会给假通过。
       */
      const cf = opts.curseforge ?? unconfiguredCurseforge
      const queries = (cfManifest?.files ?? [])
        .filter((f) => f.required !== false)
        .map((f) => ({ projectId: f.projectID, fileId: f.fileID }))

      let infos: ReadonlyMap<number, CfFileInfo> = new Map()
      if (cf.configured && queries.length > 0) {
        yield Op.progress('cf.resolve', 0, queries.length, `解析 CurseForge 文件（${cf.label}）`)
        try {
          infos = await cf.getFiles(queries, signal)
          yield Op.log('info', 'cf.resolved', {
            source: cf.label,
            files: queries.length,
            resolved: infos.size,
          })
        } catch (err) {
          // 解析失败不该让整个预检崩掉：退回到「这一步没做」的老结论。
          // 镜像 429 / 官方接口报错都是 CurseforgeError，和断网一样属于「这次没查成」，
          // 不是「这个包有问题」。
          if (err instanceof NetworkError || err instanceof CurseforgeError) {
            yield Op.log('warn', 'cf.resolve_failed', { message: err.message })
          } else throw err
        }
        yield Op.progress('cf.resolve', queries.length, queries.length, '解析 CurseForge 文件')
      }

      if (signal.aborted) return

      const versions = [...infos.values()].map(cfFileToVersionInfo)
      if (versions.length === 0) {
        // 一个都没解析出来（没 key 且镜像不可用、或清单为空）：保持原来的诚实说法。
        // stats 保持缺省——全部 unresolved，verdict 落到 unknown
        findings.push({
          severity: 'warning',
          code: 'CF_NO_MOD_CHECK',
          message: `整合包声明了 ${instance.mods.length} 个 CurseForge 文件；这次没能解析它们的元数据`,
          hint:
            '没 key 时会走 MCIM 镜像逐个查；镜像不可用时可加 --china 或设置 ' +
            'BLOCKPILOT_CF_API_KEY 后重试。Java 与加载器版本仍然可参考',
        })
      } else {
        const map = new Map(versions.map((v) => [v.versionId, v]))
        findings.push(...checkInstance({ instance, versions: map }))
        findings.push(...cfDependencyFindings(instance, versions))
        // 没解析到的文件是「校验不了」，不是「有问题」——数字上要分开
        stats = {
          mods: instance.mods.length,
          resolved: map.size,
          unresolved: instance.mods.length - map.size,
        }
      }
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
          yield Op.failed(
            'NETWORK_ERROR',
            err.message,
            '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
          )
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
            yield Op.failed(
              'NETWORK_ERROR',
              err.message,
              '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
            )
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
        yield Op.log('warn', 'deps.closure.skipped', {
          reason: 'source cannot resolve by projectId',
        })
      }

      plan =
        closure === null
          ? EMPTY_PLAN
          : buildRepairPlan(closure, {
              verified: false,
              ...(nameOf === undefined ? {} : { nameOf }),
            })
      // map 里没有的，就是没查到的——本地文件和坏 id 都在里面，不要重复计。
      stats = {
        mods: instance.mods.length,
        resolved: map.size,
        unresolved: instance.mods.length - map.size,
      }
    }

    if (signal.aborted) return

    yield Op.result(
      assembleReport({
        findings,
        stats,
        target: { gameVersion: instance.gameVersion, loader: instance.loader },
        plan,
      }),
    )
    yield Op.done()
  })
}
