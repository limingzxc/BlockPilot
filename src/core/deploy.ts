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
import { checkAssets } from './preflight/assets.js'
import { verdictOf } from './preflight/types.js'
import type { Finding, Verdict } from './preflight/types.js'
import { scanInstanceDir } from './instance/scan.js'
import { writeInstanceMarker } from './instance/marker.js'
import { createVanillaSetup } from './setup/vanilla.js'
import { createFabricSetup } from './setup/fabric.js'
import { createForgeSetup } from './setup/forge.js'
import { buildCurseforgeTasks, buildPackTasks, extractOverrides } from './setup/pack.js'
import { CurseforgeError, CurseforgeSource } from '../sources/curseforge.js'
import type { CfFileInfo } from '../sources/curseforge.js'
import { NetworkError } from './http.js'

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
  /** CurseForge API 客户端。缺省读 BLOCKPILOT_CF_API_KEY */
  readonly curseforge?: CurseforgeSource
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
  /** overrides 里直接塞的 jar 数：这些不受 API key 限制，装完就在 mods/ 里 */
  readonly overridesMods: number
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
    // 有 key 就走完整安装：换 URL → 与 mrpack 相同的下载 / 解压 / 检查流程。
    const index = pack.mrpackIndex
    let cfFiles: ReadonlyMap<number, CfFileInfo> | undefined
    /** 没有 API key：清单文件全部落到「需手动下载」，其余步骤照常 */
    let cfNoKey = false
    if (index === undefined) {
      const manifest = pack.curseforgeManifest
      if (manifest === undefined) {
        yield Op.failed('BAD_MODPACK', '这个包既不是 .mrpack，也没有 CurseForge 的 manifest.json')
        return
      }
      const cf = opts.curseforge ?? new CurseforgeSource()
      if (!cf.configured) {
        /**
         * 没有 key 时**降级而不是拒绝**：加载器与 overrides 照样装，
         * 清单里的文件单独列出来让用户自己想办法（issue #13）。
         *
         * 直接 exit 1 的代价很具体——连 overrides 里那几十个 jar、以及
         * Forge/NeoForge 的安装都做不了，用户只能手工拼。
         */
        cfNoKey = true
        cfFiles = new Map()
        yield Op.log('warn', 'deploy.cf_no_key', { files: manifest.files.length })
      } else {
        try {
          cfFiles = await cf.getFiles(
            manifest.files.map((f) => f.fileID),
            signal,
          )
        } catch (err) {
          if (err instanceof CurseforgeError) {
            yield Op.failed(err.code, err.message, '检查 BLOCKPILOT_CF_API_KEY 是否有效、是否还有配额')
            return
          }
          if (err instanceof NetworkError) {
            yield Op.failed('NETWORK_ERROR', err.message, '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理')
            return
          }
          throw err
        }
      }
    }

    yield Op.log('info', 'deploy.pack', {
      name: instance.name,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      files: index !== undefined ? index.files.length : (pack.curseforgeManifest?.files.length ?? 0),
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
    const built =
      index !== undefined
        ? {
            tasks: buildPackTasks(index, opts.layout),
            unresolved: [] as { fileName: string; error: string }[],
          }
        : buildCurseforgeTasks(pack.curseforgeManifest!, cfFiles!, opts.layout, { noKey: cfNoKey })
    const tasks = built.tasks
    const modsPrefix = `${join(opts.layout.gameDir, 'mods')}${sep}`
    const mods = tasks.filter((t) => t.destPath.startsWith(modsPrefix)).length
    const batch = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: { ok: 'deploy.ok', cached: 'deploy.cached', failed: 'deploy.failed', progressId: 'deploy' },
    })
    const downloaded = batch.downloaded
    const skipped = batch.skipped
    // API 换不到 URL 的文件也算失败：不能因为「没进下载队列」就当作装好了
    const failed = [...built.unresolved, ...batch.failed]

    // ---- 4. overrides ----
    yield Op.log('info', 'deploy.step', { step: 'overrides' })
    let overrides = 0
    let overridesMods = 0
    try {
      const extracted = extractOverrides(opts.packPath, opts.layout.gameDir)
      overrides = extracted.files
      overridesMods = extracted.mods
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
    const findings = [
      ...checkLocalInstance(scan, {
        gameVersion: instance.gameVersion,
        loaderVersion: instance.loader.version,
      }),
      // 资源不装在 mods 里，但缺了同样起不来：装完自检也要看这一层
      ...checkAssets(opts.layout.gameDir, instance.gameVersion, opts.layout.assets),
    ]
    const verdict = verdictOf(findings)
    yield Op.log('info', 'deploy.check', {
      verdict,
      blockers: findings.filter((f) => f.severity === 'blocker').length,
      findings: findings.length,
    })

    yield Op.result({
      packName: instance.name,
      gameVersion: instance.gameVersion,
      loaderKind: instance.loader.kind,
      loaderVersion: instance.loader.version,
      playableVersionId,
      files: tasks.length,
      mods,
      modsDownloaded: downloaded,
      modsSkipped: skipped,
      overrides,
      overridesMods,
      failed,
      check: { verdict, findings },
    })
    yield Op.done()
  })
}
