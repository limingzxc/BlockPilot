import { join, sep } from 'node:path'
import type { CfFileInfo } from '../curseforge.js'
import { CurseforgeError, unconfiguredCurseforge } from '../curseforge.js'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/mirrors.js'
import { errMessage } from '../errors.js'
import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import { NetworkError } from '../http.js'
import { readLock } from '../instance/lock.js'
import { forwardStep } from '../operations/forward.js'
import type { PackFileRead } from '../pack/index.js'
import { readPackFile } from '../pack/index.js'
import { createLoaderInstall, loaderNeedsJava, SUPPORTED_LOADERS } from '../setup/loader.js'
import { extractOverrides } from '../setup/pack.js'
import { createVanillaSetup } from '../setup/vanilla.js'
import { runPostCheck } from './post-check.js'
import { buildSourceTasks } from './source-tasks.js'
import type { DeployOptions, DeployResult, LoaderStepOptions, VanillaStepOptions } from './types.js'

export type {
  DeployDeps,
  DeployOptions,
  DeployResult,
  LoaderStepOptions,
  LoaderStepResult,
  VanillaStepOptions,
} from './types.js'
/** deploy 能装的加载器。名单由 `setup/loader.ts` 的分派表派生。 */
export { SUPPORTED_LOADERS }

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

    /**
     * 同一实例换包：旧 lock 指向别的包时提醒一句。
     *
     * 旧包的模组不会自动删除（overrides 还可能跳过），verify 又只看 lock，
     * 所以这些 jar 会静默留在 mods/ 里。说一句，比让用户自己发现「怎么还有旧模组」好。
     */
    try {
      const previous = readLock(opts.layout.gameDir)
      if (previous !== null && previous.pack.name !== instance.name) {
        yield Op.log('warn', 'deploy.pack_changed', {
          from: previous.pack.name,
          to: instance.name,
          previousFiles: previous.files.length,
        })
      }
    } catch {
      // lock 坏了是 verify 的事；deploy 稍后会重写它，不该挡安装
    }

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
    const needsJava = loaderNeedsJava(instance.loader.kind)
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
        createLoaderInstall({
          kind: o.kind,
          layout: o.layout,
          gameVersion: o.gameVersion,
          loaderVersion: o.loaderVersion,
          ...(o.java === undefined ? {} : { java: o.java }),
          ...(o.proxy === undefined ? {} : { proxy: o.proxy }),
          ...(o.mirror === undefined ? {} : { mirror: o.mirror }),
          sources: o.sources,
          concurrency: o.concurrency,
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
    const built = buildSourceTasks({
      pack,
      cfFiles,
      cfNoKey,
      layout: opts.layout,
      ...(opts.allowHosts === undefined ? {} : { allowHosts: opts.allowHosts }),
    })
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

    // ---- 5. 部署后自检 + 已装清单 ----
    // 装在完不等于能跑：mod 的版本约束、loader 下限、缺失依赖都要在启动前暴露。
    // 不做这一步的话，问题要等游戏启动时才在千行日志里报 HARD_DEP。
    yield Op.log('info', 'deploy.step', { step: 'check' })
    const post = runPostCheck({
      layout: opts.layout,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      ...(opts.host === undefined ? {} : { host: opts.host }),
      tasks,
      lock: {
        packName: instance.name,
        packKind: pack.kind,
        packFile: opts.packPath,
        // `complete` 只看「这次部署有没有失败项」——preflight 判 blocked
        // 是「装完跑不起来」，不是「没装完」，两件事不能混。
        complete: failed.length === 0 && !overridesFailed,
      },
    })
    yield Op.log('info', 'deploy.check', {
      verdict: post.check.verdict,
      blockers: post.check.findings.filter((f) => f.severity === 'blocker').length,
      findings: post.check.findings.length,
      unresolved: post.check.stats.unresolved,
    })
    if (post.lockPath !== undefined) {
      yield Op.log('info', 'deploy.lock', { path: post.lockPath, files: tasks.length })
    }
    if (post.lockError !== undefined) {
      yield Op.log('warn', 'deploy.lock_failed', { message: post.lockError })
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
      ...(post.lockPath === undefined ? {} : { lockPath: post.lockPath }),
      check: post.check,
    })
    yield Op.done()
  })
}
