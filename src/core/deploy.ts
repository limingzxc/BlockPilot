import { join, sep } from 'node:path'
import type { CfFileInfo, CurseforgeLike } from './curseforge.js'
import { CurseforgeError, unconfiguredCurseforge } from './curseforge.js'
import { runDownloadBatch } from './download/batch.js'
import { defaultSources } from './download/sources.js'
import type { Mirror } from './download/types.js'
import { errMessage } from './errors.js'
import type { OpEvent } from './events.js'
import { Op } from './events.js'
import { NetworkError } from './http.js'
import { buildLock, toLockedFile, writeLock } from './instance/lock.js'
import { writeInstanceMarker } from './instance/marker.js'
import { scanInstanceDir } from './instance/scan.js'
import type { HostProfile, LoaderKind } from './instance.js'
import type { Layout } from './layout.js'
import type { Operation } from './operation.js'
import { defineOperation } from './operation.js'
import type { PackFileRead } from './preflight/read-pack.js'
import { readPackFile } from './preflight/read-pack.js'
import type { ReportStats } from './preflight/report.js'
import { preflightDir } from './preflight/report.js'
import type { Finding, Verdict } from './preflight/types.js'
import { createFabricSetup } from './setup/fabric.js'
import { createForgeSetup } from './setup/forge.js'
import { buildCurseforgeTasks, buildPackTasks, extractOverrides } from './setup/pack.js'
import { createQuiltSetup } from './setup/quilt.js'
import { createVanillaSetup } from './setup/vanilla.js'
import { readAssetIndexId, readJavaMajor } from './version/java-major.js'

/** deploy 能装的加载器。Quilt 与 Fabric 共用 profile 流程（ADR-0040 后续）。 */
export const SUPPORTED_LOADERS: ReadonlySet<LoaderKind> = new Set([
  'fabric',
  'quilt',
  'forge',
  'neoforge',
])

export interface DeployOptions {
  readonly packPath: string
  /** 已经读过的包。CLI 先读它拿游戏版本/加载器，不必在这里再解一遍 zip */
  readonly pack?: PackFileRead
  readonly layout: Layout
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
  /** 跑 Forge installer 用的 java。Fabric 不需要 */
  readonly java?: string
  /** installer 的下载走这个代理。不填用环境变量 */
  readonly proxy?: string
  /** 元数据与文件都走国内镜像（CLI 的 --china） */
  readonly mirror?: boolean
  /**
   * CurseForge 解析器。缺省按「有 key 走官方、没有走镜像」自动选
   * （见 resolveCurseforge）。测试可注入假实现。
   */
  readonly curseforge?: CurseforgeLike
  /**
   * mrpack 清单里额外放行的下载域名（`--allow-host`）。
   *
   * Modrinth 规范只允许 cdn.modrinth.com / github.com / raw.githubusercontent.com /
   * gitlab.com。本地服务测试与私有镜像用这个显式放行，默认不放宽。
   */
  readonly allowHosts?: readonly string[]
  /**
   * 重跑 deploy 时覆盖 overrides 里已存在的文件（`--overwrite-overrides`）。
   *
   * 缺省跳过：ADR-0012 承诺「重跑是安全的」，而覆盖会冲掉用户改过的 config/ 与 options.txt。
   */
  readonly overwriteOverrides?: boolean
  /**
   * 本机环境。给了就在部署后自检里查 Java；不给就只检查模组与 assets。
   *
   * 没有这个字段，自检**结构上不可能**发现 Java 不对：
   * 装完打「通过」，`run` 紧接着因为 Java 版本死掉。见 ADR-0037。
   */
  readonly host?: HostProfile
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
  readonly sources: readonly Mirror[]
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
  readonly sources: readonly Mirror[]
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
  /** overrides 里因为已存在而跳过的文件数。非 0 说明这次重跑保留了用户改动 */
  readonly overridesSkipped: number
  /** 已装内容清单的落盘路径。写失败时没有这个字段 */
  readonly lockPath?: string
  /** overrides 里直接塞的 jar 数：这些不受 API key 限制，装完就在 mods/ 里 */
  readonly overridesMods: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  /** 部署后的自检结果。非 ok 就说明装完也起不来 */
  readonly check: {
    readonly verdict: Verdict
    readonly findings: readonly Finding[]
    /** 和 `preflight <实例目录>` 报的是同一份计数：resolved 校验过，unresolved 没校验到 */
    readonly stats: ReportStats
  }
}

export function createDeploy(opts: DeployOptions): Operation<DeployResult> {
  return defineOperation<DeployResult>('deploy', async function* (signal) {
    let pack: PackFileRead
    try {
      pack = opts.pack ?? readPackFile(opts.packPath)
    } catch (err) {
      yield Op.failed(
        'BAD_MODPACK',
        errMessage(err),
        '目前支持 .mrpack、CurseForge 的 .zip（带 manifest.json）',
      )
      return
    }
    const instance = pack.instance

    // CurseForge：fileID → 下载 URL 必须查 CF 的 API（要 key）。
    // 有 key 就走完整安装：换 URL → 与 mrpack 相同的下载 / 解压 / 检查流程。
    let cfFiles: ReadonlyMap<number, CfFileInfo> = new Map()
    /** 没有 API key：清单文件全部落到「需手动下载」，其余步骤照常 */
    let cfNoKey = false
    if (pack.kind === 'curseforge') {
      const manifest = pack.curseforgeManifest
      const cf = opts.curseforge ?? unconfiguredCurseforge
      if (!cf.configured) {
        /**
         * 没有 key 时**降级而不是拒绝**：加载器与 overrides 照样装，
         * 清单里的文件单独列出来让用户自己想办法（issue #13）。
         *
         * 直接 exit 1 的代价很具体——连 overrides 里那几十个 jar、以及
         * Forge/NeoForge 的安装都做不了，用户只能手工拼。
         */
        cfNoKey = true
        yield Op.log('warn', 'deploy.cf_no_key', { files: manifest.files.length })
      } else {
        yield Op.log('info', 'deploy.cf_source', { source: cf.label })
        try {
          cfFiles = await cf.getFiles(
            manifest.files.map((f) => ({ projectId: f.projectID, fileId: f.fileID })),
            signal,
          )
        } catch (err) {
          if (err instanceof CurseforgeError) {
            yield Op.failed(
              err.code,
              err.message,
              '检查 BLOCKPILOT_CF_API_KEY 是否有效、是否还有配额',
            )
            return
          }
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
      }
    }

    yield Op.log('info', 'deploy.pack', {
      name: instance.name,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      files:
        pack.kind === 'mrpack'
          ? pack.mrpackIndex.files.length
          : pack.curseforgeManifest.files.length,
    })

    if (!SUPPORTED_LOADERS.has(instance.loader.kind)) {
      yield Op.failed(
        'UNSUPPORTED_LOADER',
        `这个整合包用的是 ${instance.loader.kind} ${instance.loader.version}`,
        '目前支持 Fabric、Quilt、Forge 与 NeoForge',
      )
      return
    }

    /**
     * 只有 Forge / NeoForge 需要 java 跑 installer；Fabric / Quilt 只下文件。
     *
     * 这个判断必须在原版下载之前：否则一个缺 java 的 Forge 包会先白下一轮
     * 90 MB 的原版文件，再报「需要 java」。
     */
    const needsJava = instance.loader.kind === 'forge' || instance.loader.kind === 'neoforge'
    if (needsJava && opts.java === undefined) {
      yield Op.failed(
        'NEED_JAVA',
        `${instance.loader.kind} 需要 java 来跑 installer`,
        '传 --java 或先跑 java 检测',
      )
      return
    }

    const sources = opts.sources ?? defaultSources()
    const concurrency = opts.concurrency ?? 4

    const deps = opts.deps ?? {}
    const vanillaStep = deps.vanilla ?? ((o: VanillaStepOptions) => createVanillaSetup(o))
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
          : o.kind === 'quilt'
            ? createQuiltSetup({
                layout: o.layout,
                gameVersion: o.gameVersion,
                loaderVersion: o.loaderVersion,
                sources: o.sources,
                concurrency: o.concurrency,
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
    let playableVersionId: string | undefined
    const loaderFailed = yield* forwardStep(
      loaderStep({
        layout: opts.layout,
        gameVersion: instance.gameVersion,
        kind: instance.loader.kind,
        loaderVersion: instance.loader.version,
        ...(opts.java === undefined ? {} : { java: opts.java }),
        ...(opts.proxy === undefined ? {} : { proxy: opts.proxy }),
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
      pack.kind === 'mrpack'
        ? (() => {
            const mr = buildPackTasks(
              pack.mrpackIndex,
              opts.layout,
              opts.allowHosts === undefined ? {} : { allowHosts: opts.allowHosts },
            )
            return { tasks: mr.tasks, unresolved: mr.rejected }
          })()
        : buildCurseforgeTasks(pack.curseforgeManifest, cfFiles, opts.layout, { noKey: cfNoKey })
    const tasks = built.tasks
    const modsPrefix = `${join(opts.layout.gameDir, 'mods')}${sep}`
    const mods = tasks.filter((t) => t.destPath.startsWith(modsPrefix)).length
    const batch = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: {
        ok: 'deploy.ok',
        cached: 'deploy.cached',
        failed: 'deploy.failed',
        progressId: 'deploy',
      },
    })
    const downloaded = batch.downloaded
    const skipped = batch.skipped
    // API 换不到 URL 的文件也算失败：不能因为「没进下载队列」就当作装好了
    const failed = [...built.unresolved, ...batch.failed]

    // ---- 4. overrides ----
    yield Op.log('info', 'deploy.step', { step: 'overrides' })
    let overrides = 0
    let overridesMods = 0
    let overridesSkipped = 0
    let overridesFailed = false
    try {
      const extracted = await extractOverrides(
        opts.packPath,
        opts.layout.gameDir,
        opts.overwriteOverrides === true ? { overwrite: true } : {},
      )
      overrides = extracted.files
      overridesMods = extracted.mods
      overridesSkipped = extracted.skipped
      if (overridesSkipped > 0) {
        yield Op.log('warn', 'deploy.overrides_skipped', { count: overridesSkipped })
      }
    } catch (err) {
      overridesFailed = true
      yield Op.log('warn', 'deploy.overrides_failed', { message: errMessage(err) })
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
    /**
     * 自检不自己拼 findings：和 `preflight <实例目录>` 调同一个 module。
     *
     * 手抄会漏：只查模组与 assets 就漏掉 Java，也没有「有东西没校验到就不算 ok」
     * 那条规则，于是自检说通过、run 说崩（ADR-0037）。
     */
    // 版本 JSON 的 javaVersion 是权威值；读不到再退回 gameVersion 查表。
    // assetIndex.id 同理：现代版本的 index 叫 5 / 17 / 32，不能按 MC 版本猜。
    const versionJson = opts.layout.versionJson(instance.gameVersion)
    const javaMajor = readJavaMajor(versionJson)
    const assetIndexId = readAssetIndexId(versionJson)
    const check = preflightDir({
      dir: opts.layout.gameDir,
      scan,
      // 资源装在 <root>/assets，不在实例目录里
      assetsDir: opts.layout.assets,
      ...(opts.host === undefined ? {} : { host: opts.host }),
      ...(javaMajor === undefined ? {} : { javaMajor }),
      ...(assetIndexId === undefined ? {} : { assetIndexId }),
    })
    yield Op.log('info', 'deploy.check', {
      verdict: check.verdict,
      blockers: check.findings.filter((f) => f.severity === 'blocker').length,
      findings: check.findings.length,
      unresolved: check.stats.unresolved,
    })

    /**
     * 已装内容清单。`complete` 只看「这次部署有没有失败项」——preflight 判 blocked
     * 是「装完跑不起来」，不是「没装完」，两件事不能混。
     */
    const lockedFiles = tasks.map((t) => toLockedFile(t, opts.layout.gameDir))
    let lockPath: string | undefined
    try {
      lockPath = writeLock(
        opts.layout.gameDir,
        buildLock({
          packName: instance.name,
          packKind: pack.kind,
          packFile: opts.packPath,
          gameVersion: instance.gameVersion,
          loader: instance.loader,
          complete: failed.length === 0 && !overridesFailed,
          files: lockedFiles,
        }),
      )
      yield Op.log('info', 'deploy.lock', { path: lockPath, files: lockedFiles.length })
    } catch (err) {
      // 清单写不下去不影响本次安装，但 verify / update 会缺前置：必须说出来
      yield Op.log('warn', 'deploy.lock_failed', { message: errMessage(err) })
    }

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
      overridesSkipped,
      failed,
      ...(lockPath === undefined ? {} : { lockPath }),
      check: { verdict: check.verdict, findings: check.findings, stats: check.stats },
    })
    yield Op.done()
  })
}
