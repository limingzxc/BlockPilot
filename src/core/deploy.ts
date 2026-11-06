import { join, sep } from 'node:path'

import { Op } from './events.js'
import type { OpEvent } from './events.js'
import { defineOperation } from './operation.js'
import type { Operation } from './operation.js'
import { runDownloadBatch } from './download/batch.js'
import { defaultSources } from './download/sources.js'
import type { DownloadSource } from './download/types.js'
import type { Layout } from './layout.js'
import type { LoaderKind } from './instance.js'
import { readPackFile } from './preflight/read-pack.js'
import { checkLocalInstance } from './preflight/local.js'
import { verdictOf } from './preflight/types.js'
import type { Finding, Verdict } from './preflight/types.js'
import { scanInstanceDir } from './instance/scan.js'
import { writeInstanceMarker } from './instance/marker.js'
import { createVanillaSetup } from './setup/vanilla.js'
import { createFabricSetup } from './setup/fabric.js'
import { createForgeSetup } from './setup/forge.js'
import { buildPackTasks, extractOverrides } from './setup/pack.js'

export interface DeployOptions {
  readonly packPath: string
  readonly layout: Layout
  readonly sources?: readonly DownloadSource[]
  readonly concurrency?: number
  /** 跑 Forge installer 用的 java。Fabric 不需要 */
  readonly java?: string
  /** installer 的下载走这个代理。不填用环境变量 */
  readonly proxy?: string
  /** 元数据与文件都走国内镜像（CLI 的 --china） */
  readonly mirror?: boolean
  /**
   * 步骤工厂，注入点。缺省用真实的 setup modules。
   * 测试传假的 Operation 就能离线验证编排契约，不用下载任何东西。
   */
  readonly deps?: DeployDeps
}

/** 加载器步骤的契约：result.versionId 就是装完能启动的版本 id。 */
export interface LoaderStepResult {
  readonly versionId: string
}

export interface VanillaStepOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources: readonly DownloadSource[]
  readonly concurrency: number
}

export interface LoaderStepOptions {
  readonly layout: Layout
  readonly gameVersion: string
  readonly kind: LoaderKind
  readonly loaderVersion: string
  readonly java?: string
  readonly proxy?: string
  readonly mirror?: boolean
  readonly sources: readonly DownloadSource[]
  readonly concurrency: number
}

export interface DeployDeps {
  /** 原版文件步骤：产出一个 result 即视为成功 */
  readonly vanilla?: (opts: VanillaStepOptions) => Operation<unknown>
  readonly loader?: (opts: LoaderStepOptions) => Operation<LoaderStepResult>
}

/**
 * 转发子 Operation 的事件，返回是否以 failed 结束（`yield*` 取返回值）。
 *
 * 契约——deploy 对所有子步骤的约定，只写这一次：
 * - log / progress / artifact 原样转发
 * - result 交给 onResult 消费，不转发：result 一个 Operation 只 yield 一次，
 *   deploy 自己还要产出自己的 result，混在一起消费者分不清
 * - done 不转发：子步骤结束不代表整体结束
 * - failed 原样转发并立即中止整体
 */
async function* forwardStep<T>(
  step: Operation<T>,
  signal: AbortSignal,
  onResult: (value: T) => void,
): AsyncGenerator<OpEvent<never>, boolean> {
  for await (const ev of step.run(signal)) {
    if (ev.type === 'result') {
      onResult(ev.value)
      continue
    }
    if (ev.type === 'done') continue
    if (ev.type === 'failed') {
      yield ev
      return true
    }
    yield ev as OpEvent<never>
  }
  return false
}

export interface DeployResult {
  readonly packName: string
  readonly gameVersion: string
  readonly loaderKind: LoaderKind
  readonly loaderVersion: string
  /** 装完之后用来启动的版本 id */
  readonly playableVersionId: string
  /** 清单里要下载的文件总数（模组、资源包、光影……） */
  readonly files: number
  /** 其中落在 mods/ 下的个数。整合包常带资源包，两个数不该混着报 */
  readonly mods: number
  readonly modsDownloaded: number
  readonly modsSkipped: number
  readonly overrides: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  /** 部署后的自检结果。非 ok 就说明装完也起不来 */
  readonly check: {
    readonly verdict: Verdict
    readonly findings: readonly Finding[]
  }
}

export function createDeploy(opts: DeployOptions): Operation<DeployResult> {
  return defineOperation<DeployResult>('deploy', async function* (signal) {
    let pack
    try {
      pack = readPackFile(opts.packPath)
    } catch (err) {
      yield Op.failed(
        'BAD_MODPACK',
        String(err instanceof Error ? err.message : err),
        '目前支持 .mrpack、CurseForge 的 .zip（带 manifest.json）',
      )
      return
    }
    const instance = pack.instance

    // CurseForge：fileID → 下载 URL 必须查 CF 的 API（要 key）。
    // 事件码与 preflight 统一为 CF_API_REQUIRED，消费者可一处匹配
    if (pack.mrpackIndex === undefined || !pack.ability.givesDownloadUrls) {
      yield Op.failed(
        'CF_API_REQUIRED',
        '这是 CurseForge 整合包，下载它的文件需要 CurseForge API key',
        '文件清单只有 projectID/fileID，要拿到 URL 与校验值必须调 API；' +
          '可以先跑 preflight 看 MC 版本与加载器',
      )
      return
    }
    const index = pack.mrpackIndex

    yield Op.log('info', 'deploy.pack', {
      name: index.name,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      files: index.files.length,
    })

    const supported = new Set(['fabric', 'forge', 'neoforge'])
    if (!supported.has(instance.loader.kind)) {
      yield Op.failed(
        'UNSUPPORTED_LOADER',
        `这个整合包用的是 ${instance.loader.kind} ${instance.loader.version}`,
        '目前支持 Fabric、Forge 与 NeoForge',
      )
      return
    }

    const sources = opts.sources ?? defaultSources()
    const concurrency = opts.concurrency ?? 4

    const deps = opts.deps ?? {}
    const vanillaStep =
      deps.vanilla ??
      ((o: VanillaStepOptions) => createVanillaSetup(o))
    const loaderStep =
      deps.loader ??
      ((o: LoaderStepOptions) =>
        o.kind === 'fabric'
          ? createFabricSetup({
              layout: o.layout,
              gameVersion: o.gameVersion,
              loaderVersion: o.loaderVersion,
              sources: o.sources,
              concurrency: o.concurrency,
              ...(o.mirror === undefined ? {} : { mirror: o.mirror }),
            })
          : createForgeSetup({
              layout: o.layout,
              gameVersion: o.gameVersion,
              kind: o.kind === 'neoforge' ? 'neoforge' : 'forge',
              forgeVersion: o.loaderVersion,
              java: o.java ?? '',
              ...(o.proxy === undefined ? {} : { proxy: o.proxy }),
              sources: o.sources,
            }))

    // ---- 1. 原版：client jar + libraries + assetIndex + natives ----
    yield Op.log('info', 'deploy.step', { step: 'vanilla' })
    let vanillaOk = false
    const vanillaFailed = yield* forwardStep(
      vanillaStep({ layout: opts.layout, versionId: instance.gameVersion, sources, concurrency }),
      signal,
      () => {
        vanillaOk = true
      },
    )
    if (vanillaFailed) return
    if (!vanillaOk) {
      yield Op.failed('VANILLA_FAILED', '原版文件没装完')
      return
    }

    // ---- 2. 加载器 ----
    yield Op.log('info', 'deploy.step', { step: 'loader' })

    // Forge：靠官方 installer 下载依赖并给 client 打补丁，比自己解析 install_profile 可靠
    if (instance.loader.kind !== 'fabric' && opts.java === undefined) {
      yield Op.failed('NEED_JAVA', 'Forge 需要 java 来跑 installer', '传 --java 或先跑 java 检测')
      return
    }
    let playableVersionId: string | undefined
    const loaderFailed = yield* forwardStep(
      loaderStep({
        layout: opts.layout,
        gameVersion: instance.gameVersion,
        kind: instance.loader.kind,
        loaderVersion: instance.loader.version,
        java: opts.java,
        proxy: opts.proxy,
        ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
        sources,
        concurrency,
      }),
      signal,
      (value) => {
        playableVersionId = value.versionId
      },
    )
    if (loaderFailed) return

    if (playableVersionId === undefined) {
      yield Op.failed('LOADER_FAILED', '加载器没装成')
      return
    }

    // ---- 3. 整合包文件 ----
    yield Op.log('info', 'deploy.step', { step: 'files' })
    const tasks = buildPackTasks(index, opts.layout)
    const modsPrefix = `${join(opts.layout.gameDir, 'mods')}${sep}`
    const mods = tasks.filter((t) => t.destPath.startsWith(modsPrefix)).length
    const { downloaded, skipped, failed } = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: { ok: 'deploy.ok', cached: 'deploy.cached', failed: 'deploy.failed', progressId: 'deploy' },
    })

    // ---- 4. overrides ----
    yield Op.log('info', 'deploy.step', { step: 'overrides' })
    let overrides = 0
    try {
      overrides = extractOverrides(opts.packPath, opts.layout.gameDir)
    } catch (err) {
      yield Op.log('warn', 'deploy.overrides_failed', { message: String(err) })
    }

    // ---- 5. 部署后自检 ----
    // 装在完不等于能跑：mod 的版本约束、loader 下限、缺失依赖都要在启动前暴露。
    // 不做这一步的话，问题要等游戏启动时才在千行日志里报 HARD_DEP。
    yield Op.log('info', 'deploy.step', { step: 'check' })
    // 先写版本标记，再自检：这样自检走的是「和用户 preflight 完全一样」的路径，
    // 而不是靠 fallback 参数凑出来的版本号
    writeInstanceMarker(opts.layout.gameDir, {
      gameVersion: instance.gameVersion,
      loader: { kind: instance.loader.kind, version: instance.loader.version },
    })
    const scan = scanInstanceDir(opts.layout.gameDir, {
      fallbackGameVersion: instance.gameVersion,
      fallbackLoader: instance.loader,
    })
    const findings = checkLocalInstance(scan, {
      gameVersion: instance.gameVersion,
      loaderVersion: instance.loader.version,
    })
    const verdict = verdictOf(findings)
    yield Op.log('info', 'deploy.check', {
      verdict,
      blockers: findings.filter((f) => f.severity === 'blocker').length,
      findings: findings.length,
    })

    yield Op.result({
      packName: index.name,
      gameVersion: instance.gameVersion,
      loaderKind: instance.loader.kind,
      loaderVersion: instance.loader.version,
      playableVersionId,
      files: tasks.length,
      mods,
      modsDownloaded: downloaded,
      modsSkipped: skipped,
      overrides,
      failed,
      check: { verdict, findings },
    })
    yield Op.done()
  })
}
