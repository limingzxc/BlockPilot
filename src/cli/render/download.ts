/**
 * 下载类事件的统一渲染。
 *
 * 七条命令此前各写一份「进度行 + ↓ / = / ✗」：事件码前缀不同（`fabric.*`、
 * `quilt.*`、`setup.*`、`deploy.*`、`download.*`），于是同一组语义被抄了四遍，
 * 细节还各自漂移——只有 install 显示体积，fabric/quilt 不处理缓存命中。
 *
 * 这个 module 只认「成功 / 缓存 / 失败」三个码与一个前缀，命令声明差异，实现只有一份。
 */

import type { OpEvent } from '../../core/events/index.js'
import { C, humanBytes } from '../output/ansi.js'
import { writeProgress } from '../output/progress.js'

export interface DownloadEventCodes {
  readonly ok: string
  readonly cached: string
  readonly failed: string
}

export interface DownloadRenderOptions {
  /** 进度行前缀，如「下载」「原版」 */
  readonly label?: string
  /**
   * 只报进度与失败。
   *
   * 原版 setup 有几百个文件，逐条播报会把终端刷爆；失败仍要逐条说清楚。
   */
  readonly quiet?: boolean
  /** 进度行是否带文件名。assets 有 3000+ 个哈希文件名，显示出来只是噪音 */
  readonly showFileName?: boolean
}

type ProgressEvent = Extract<OpEvent<never>, { type: 'progress' }>
type LogEvent = Extract<OpEvent<never>, { type: 'log' }>

interface DownloadLogData {
  readonly file?: string
  readonly bytes?: number
  readonly source?: string
  readonly error?: string
}

export interface DownloadRenderer {
  progress(ev: ProgressEvent): void
  log(ev: LogEvent): void
}

export function downloadRenderer(
  codes: DownloadEventCodes,
  opts: DownloadRenderOptions = {},
): DownloadRenderer {
  const prefix = opts.label === undefined ? '' : `${opts.label} `
  return {
    progress: (ev) => writeProgress(ev, prefix, opts.showFileName !== false),
    log: (ev) => {
      // 码是运行时变量，TypeScript 收不窄载荷；这里按三个码的共同字段读
      const data = ev.data as DownloadLogData | undefined
      const file = data?.file ?? ''
      if (ev.code === codes.ok) {
        if (opts.quiet === true) return
        const size = data?.bytes === undefined ? '' : `${humanBytes(data.bytes)} · `
        process.stderr.write(
          `\r${C.green}↓${C.reset} ${file}  ${C.dim}${size}${data?.source ?? ''}${C.reset}\n`,
        )
        return
      }
      if (ev.code === codes.cached) {
        if (opts.quiet === true) return
        process.stderr.write(`\r${C.cyan}=${C.reset} ${file}  ${C.dim}已存在且校验通过${C.reset}\n`)
        return
      }
      if (ev.code === codes.failed) {
        process.stderr.write(
          `\r${C.red}✗${C.reset} ${file}  ${C.dim}${data?.error ?? ''}${C.reset}\n`,
        )
      }
    },
  }
}
