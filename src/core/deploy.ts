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
import { createVanillaSetup } from './setup/vanilla.js'
import { createFabricSetup } from './setup/fabric.js'
import { buildPackTasks, extractOverrides } from './setup/pack.js'

export interface DeployOptions {
  readonly packPath: string
  readonly layout: Layout
  readonly sources?: readonly DownloadSource[]
  readonly concurrency?: number
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

    if (instance.loader.kind !== 'fabric') {
      yield Op.failed(
        'UNSUPPORTED_LOADER',
        `这个整合包用的是 ${instance.loader.kind} ${instance.loader.version}`,
        '目前只支持 Fabric；Forge 需要跑 installer jar，还没实现',
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
    let fabricResult: { versionId: string } | undefined
    for await (const ev of createFabricSetup({
      layout: opts.layout,
      gameVersion: instance.gameVersion,
      loaderVersion: instance.loader.version,
      sources,
      concurrency,
    }).run(signal)) {
      if (ev.type === 'result') fabricResult = ev.value as { versionId: string }
      else if (ev.type === 'failed') {
        yield ev
        return
      } else if (ev.type !== 'done') yield ev
    }
    if (fabricResult === undefined) {
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

    yield Op.result({
      packName: index.name,
      gameVersion: instance.gameVersion,
      loaderKind: instance.loader.kind,
      loaderVersion: instance.loader.version,
      playableVersionId: fabricResult.versionId,
      mods: tasks.length,
      modsDownloaded: downloaded,
      modsSkipped: skipped,
      overrides,
      failed,
    })
    yield Op.done()
  })
}
