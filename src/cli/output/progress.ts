/**
 * 进度行的唯一写法。
 *
 * `prefix` 是命令自己的标签（「下载」「原版」）；渲染器与缺省渲染都走这里，
 * 不再各写一串 `\r{done}/{total}` 与尾随空格。
 *
 * TTY 单行刷新；重定向到文件/管道时没有「回车回到行首」这回事，逐条写会把整个
 * 进度糊成一行（CI 日志里就是这样），所以只在整批结束时留一行。
 */
import type { OpEvent } from '../../core/events/index.js'
import { C } from './ansi.js'

type ProgressEvent = Extract<OpEvent<never>, { type: 'progress' }>

export function writeProgress(ev: ProgressEvent, prefix = '', showLabel = true): void {
  const label = showLabel && ev.label !== '' ? `  ${ev.label}` : ''
  const body = `${prefix}${ev.done}/${ev.total}${label}`
  if (process.stderr.isTTY === true) {
    process.stderr.write(`\r${C.dim}${body}${C.reset}   `)
    if (ev.done === ev.total) process.stderr.write('\r')
  } else if (ev.done === ev.total) {
    process.stderr.write(`${C.dim}${body}${C.reset}\n`)
  }
}
