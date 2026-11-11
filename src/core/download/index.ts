import { basename, join } from 'node:path'
import type { RepairPlan } from '../deps/plan.js'
import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { runDownloadBatch } from './batch.js'
import { defaultSources } from './sources.js'
import type { DownloadTask, InstallResult, Mirror } from './types.js'

export interface InstallOptions {
  readonly plan: RepairPlan
  /** 文件落地的目录，通常是实例的 mods/ */
  readonly modsDir: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
}

export function planToTasks(plan: RepairPlan, modsDir: string): readonly DownloadTask[] {
  return plan.installs.map((i) => {
    // 文件名来自内容源，只取最后一段：`../../evil.jar` 不能写出 mods/
    const fileName = basename(i.fileName)
    return {
      url: i.url,
      fileName,
      destPath: join(modsDir, fileName),
      expectedSize: i.size,
      hashes: i.hashes,
    }
  })
}

export function createInstaller(opts: InstallOptions): Operation<InstallResult> {
  const tasks = planToTasks(opts.plan, opts.modsDir)
  const sources = opts.sources ?? defaultSources()
  const concurrency = opts.concurrency ?? 4

  return defineOperation<InstallResult>('install', async function* (signal) {
    if (tasks.length === 0) {
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

    // 下载池、逐文件事件与进度都交给 batch；这里只把汇总映射成 install 的结果。
    // 以前 install 自己复制了一份池骨架，只因为旧汇总不带逐文件结果。
    const summary = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: {
        ok: 'download.ok',
        cached: 'download.cached',
        failed: 'download.failed',
        progressId: 'install',
      },
    })

    if (summary.failed.length > 0) {
      yield Op.log('error', 'install.partial', {
        ok: summary.outcomes.length,
        failed: summary.failed.length,
      })
    }

    yield Op.result({
      downloaded: summary.outcomes,
      failed: summary.failed,
      // 缓存命中的文件也占磁盘，仍计入总量（与重构前一致）
      totalBytes: summary.outcomes.reduce((sum, o) => sum + o.bytes, 0),
      installedDir: opts.modsDir,
    })
    yield Op.done()
  })
}
