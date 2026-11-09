import { join } from 'node:path'
import type { RepairPlan } from '../deps/plan.js'
import { errMessage } from '../errors.js'
import type { OpEvent } from '../events.js'
import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { downloadOne } from './downloader.js'
import { AsyncQueue, runPool } from './queue.js'
import { defaultSources } from './sources.js'
import type { DownloadOutcome, DownloadTask, InstallResult, Mirror } from './types.js'

export interface InstallOptions {
  readonly plan: RepairPlan
  /** 文件落地的目录，通常是实例的 mods/ */
  readonly modsDir: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
}

export function planToTasks(plan: RepairPlan, modsDir: string): readonly DownloadTask[] {
  return plan.installs.map((i) => ({
    url: i.url,
    fileName: i.fileName,
    destPath: join(modsDir, i.fileName),
    expectedSize: i.size,
    hashes: i.hashes,
  }))
}

export function createInstaller(opts: InstallOptions): Operation<InstallResult> {
  const tasks = planToTasks(opts.plan, opts.modsDir)
  const sources = opts.sources ?? defaultSources()
  const concurrency = opts.concurrency ?? 4

  return defineOperation<InstallResult>('install', async function* (signal) {
    const total = tasks.length
    if (total === 0) {
      yield Op.log('info', 'install.nothing_to_do')
      yield Op.result({
        downloaded: [],
        failed: [],
        totalBytes: 0,
        installedDir: opts.modsDir,
      })
      yield Op.done()
      return
    }

    // 并发 worker 不能从 Promise 回调里 yield，所以推队列、外层拉。
    const queue = new AsyncQueue<OpEvent<never>>()
    const outcomes: DownloadOutcome[] = []
    const failures: { fileName: string; error: string }[] = []
    let finished = 0

    const runner = runPool(tasks, concurrency, async (task) => {
      if (signal.aborted) return
      try {
        const outcome = await downloadOne(task, sources, signal)
        outcomes.push(outcome)
        queue.push(
          Op.log('info', outcome.skipped ? 'download.cached' : 'download.ok', {
            file: outcome.fileName,
            bytes: outcome.bytes,
            source: outcome.source,
          }),
        )
      } catch (err) {
        const message = errMessage(err)
        failures.push({ fileName: task.fileName, error: message })
        queue.push(Op.log('error', 'download.failed', { file: task.fileName, error: message }))
      } finally {
        finished += 1
        queue.push(Op.progress('install', finished, total, task.fileName))
      }
    }).finally(() => queue.close())

    for await (const ev of queue.drain()) yield ev
    await runner

    const totalBytes = outcomes.reduce((sum, o) => sum + o.bytes, 0)

    if (failures.length > 0) {
      yield Op.log('error', 'install.partial', {
        ok: outcomes.length,
        failed: failures.length,
      })
    }

    yield Op.result({
      downloaded: outcomes,
      failed: failures,
      totalBytes,
      installedDir: opts.modsDir,
    })
    yield Op.done()
  })
}
