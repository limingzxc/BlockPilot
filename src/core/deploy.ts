import { Op } from './events.js'
import type { OpEvent } from './events.js'
import { defineOperation } from './operation.js'
import type { Operation } from './operation.js'
import { downloadOne } from './download/downloader.js'
import { AsyncQueue, runPool } from './download/queue.js'
import { defaultSources } from './download/sources.js'
import type { DownloadSource } from './download/types.js'
import type { Layout } from './layout.js'
import type { LoaderKind } from './instance.js'
import { mrpackToInstance, readMrpackIndex } from './preflight/mrpack.js'
import { checkLocalInstance } from './preflight/local.js'
import { verdictOf } from './preflight/types.js'
import type { Finding, Verdict } from './preflight/types.js'
import { scanInstanceDir } from './instance/scan.js'
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
}

export interface DeployResult {
  readonly packName: string
  readonly gameVersion: string
  readonly loaderKind: LoaderKind
  readonly loaderVersion: string
  /** 装完之后用来启动的版本 id */
  readonly playableVersionId: string
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
    const index = readMrpackIndex(opts.packPath)
    const instance = mrpackToInstance(index)

    yield Op.log('info', 'deploy.pack', {
      name: index.name,
      gameVersion: instance.gameVersion,
      loader: instance.loader,
      files: index.files.length,
    })

    if (instance.loader.kind !== 'fabric' && instance.loader.kind !== 'forge') {
      yield Op.failed(
        'UNSUPPORTED_LOADER',
        `这个整合包用的是 ${instance.loader.kind} ${instance.loader.version}`,
        '目前支持 Fabric 与 Forge',
      )
      return
    }

    const sources = opts.sources ?? defaultSources()
    const concurrency = opts.concurrency ?? 4

    // ---- 1. 原版：client jar + libraries + assetIndex + natives ----
    yield Op.log('info', 'deploy.step', { step: 'vanilla' })
    let vanillaOk = false
    for await (const ev of createVanillaSetup({
      layout: opts.layout,
      versionId: instance.gameVersion,
      sources,
      concurrency,
    }).run(signal)) {
      if (ev.type === 'result') vanillaOk = true
      else if (ev.type === 'failed') {
        yield ev
        return
      } else if (ev.type !== 'done') yield ev
    }
    if (!vanillaOk) {
      yield Op.failed('VANILLA_FAILED', '原版文件没装完')
      return
    }

    // ---- 2. 加载器 ----
    yield Op.log('info', 'deploy.step', { step: 'loader' })
    let playableVersionId: string | undefined

    if (instance.loader.kind === 'fabric') {
      for await (const ev of createFabricSetup({
        layout: opts.layout,
        gameVersion: instance.gameVersion,
        loaderVersion: instance.loader.version,
        sources,
        concurrency,
      }).run(signal)) {
        if (ev.type === 'result') playableVersionId = (ev.value as { versionId: string }).versionId
        else if (ev.type === 'failed') {
          yield ev
          return
        } else if (ev.type !== 'done') yield ev
      }
    } else {
      // Forge：靠官方 installer 下载依赖并给 client 打补丁，比自己解析 install_profile 可靠
      if (opts.java === undefined) {
        yield Op.failed('NEED_JAVA', 'Forge 需要 java 来跑 installer', '传 --java 或先跑 java 检测')
        return
      }
      for await (const ev of createForgeSetup({
        layout: opts.layout,
        gameVersion: instance.gameVersion,
        forgeVersion: instance.loader.version,
        java: opts.java,
        sources,
      }).run(signal)) {
        if (ev.type === 'result') playableVersionId = (ev.value as { versionId: string }).versionId
        else if (ev.type === 'failed') {
          yield ev
          return
        } else if (ev.type !== 'done') yield ev
      }
    }

    if (playableVersionId === undefined) {
      yield Op.failed('LOADER_FAILED', '加载器没装成')
      return
    }

    // ---- 3. 整合包文件 ----
    yield Op.log('info', 'deploy.step', { step: 'files' })
    const tasks = buildPackTasks(index, opts.layout)
    const queue = new AsyncQueue<OpEvent<never>>()
    const failed: { fileName: string; error: string }[] = []
    let done = 0
    let downloaded = 0
    let skipped = 0

    const runner = runPool(tasks, concurrency, async (task) => {
      if (signal.aborted) return
      try {
        const outcome = await downloadOne(task, sources, signal)
        if (outcome.skipped) skipped += 1
        else downloaded += 1
        queue.push(
          Op.log('info', outcome.skipped ? 'deploy.cached' : 'deploy.ok', {
            file: task.fileName,
            source: outcome.source,
          }),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ fileName: task.fileName, error: message })
        queue.push(Op.log('error', 'deploy.failed', { file: task.fileName, error: message }))
      } finally {
        done += 1
        queue.push(Op.progress('deploy', done, tasks.length, task.fileName))
      }
    }).finally(() => queue.close())

    for await (const ev of queue.drain()) yield ev
    await runner

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
      mods: tasks.length,
      modsDownloaded: downloaded,
      modsSkipped: skipped,
      overrides,
      failed,
      check: { verdict, findings },
    })
    yield Op.done()
  })
}
