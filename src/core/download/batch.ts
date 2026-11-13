/**
 * 并发下载批（架构评审候选 3）。
 *
 * 「AsyncQueue + runPool + 计数 + ok/cached/failed 事件 + progress + close」
 * 这套骨架此前在 deploy / fabric / assets / vanilla 各复制了一份（每份约 22 行），
 * 只有事件码前缀和进度粒度不同。删除测试：删掉它，第 5 个 setup 会原样长回来。
 *
 * runPool 与 AsyncQueue 已经是 seam 的位置；这里补上的是它们上面那一层——
 * 「task 流 + 事件码 → 计数与事件」。
 */

import { errMessage } from '../errors.js'
import type { LogCode, OpEvent } from '../events/index.js'
import { Op } from '../events/index.js'
import { downloadOne } from './downloader.js'
import { AsyncQueue, runPool } from './queue.js'
import type { DownloadOutcome, DownloadTask, Mirror } from './types.js'

export interface BatchCodes {
  readonly ok: LogCode
  readonly cached: LogCode
  readonly failed: LogCode
  /** progress 事件的 taskId */
  readonly progressId: string
}

export interface BatchSummary {
  readonly downloaded: number
  readonly skipped: number
  readonly bytes: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  /**
   * 每个成功/命中的文件的结果，含缓存来源与体积。
   *
   * 汇总如果只给计数，需要逐文件结果的调用方（install）就只能自己再实现一遍
   * 下载池——以前正是这样。让汇总携带 outcomes，池骨架才真正只有一个。
   */
  readonly outcomes: readonly DownloadOutcome[]
}

export interface BatchOptions {
  readonly tasks: readonly DownloadTask[]
  readonly sources: readonly Mirror[]
  readonly concurrency: number
  readonly signal: AbortSignal
  readonly codes: BatchCodes
  /**
   * 是否为每个成功/缓存的文件发一条 log 事件。
   * 模组量小（几十个）时发；assets 三千多个文件时不发，只报进度。
   */
  readonly logPerFile?: boolean
  /** 进度事件粒度：1 = 每个文件（缺省），N = 每 N 个报一次 */
  readonly progressEvery?: number
}

/** 跑一批下载任务，事件实时产出，结束返回汇总（`yield*` 取返回值）。 */
export async function* runDownloadBatch(
  opts: BatchOptions,
): AsyncGenerator<OpEvent<never>, BatchSummary> {
  const queue = new AsyncQueue<OpEvent<never>>()
  const failed: { fileName: string; error: string }[] = []
  const outcomes: DownloadOutcome[] = []
  let done = 0
  let downloaded = 0
  let skipped = 0
  let bytes = 0
  const reportEvery = opts.progressEvery ?? 1

  const runner = runPool(opts.tasks, opts.concurrency, async (task) => {
    if (opts.signal.aborted) return
    try {
      const outcome = await downloadOne(task, opts.sources, opts.signal)
      outcomes.push(outcome)
      if (outcome.skipped) skipped += 1
      else {
        downloaded += 1
        bytes += outcome.bytes
      }
      if (opts.logPerFile !== false) {
        queue.push(
          Op.log('info', outcome.skipped ? opts.codes.cached : opts.codes.ok, {
            file: task.fileName,
            bytes: outcome.bytes,
            source: outcome.source,
          }),
        )
      }
    } catch (err) {
      const message = errMessage(err)
      failed.push({ fileName: task.fileName, error: message })
      // 失败必须逐条报，否则用户不知道该重试什么
      queue.push(Op.log('error', opts.codes.failed, { file: task.fileName, error: message }))
    } finally {
      done += 1
      if (done % reportEvery === 0 || done === opts.tasks.length) {
        queue.push(Op.progress(opts.codes.progressId, done, opts.tasks.length, task.fileName))
      }
    }
  }).finally(() => queue.close())

  for await (const ev of queue.drain()) yield ev
  await runner

  return { downloaded, skipped, bytes, failed, outcomes }
}
