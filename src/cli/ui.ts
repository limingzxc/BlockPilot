/**
 * Consumer 内部的渲染 seam（架构评审候选 1）。
 *
 * Operation 的 interface 很深——run(signal) 一个方法背后是下载、取消、重试。
 * 但它到人类输出之间此前没有 adapter 位置：每个子命令都手写一遍
 * 「for await + switch + progress 刷新 + failed 渲染 + 退出码」，CLI 里复制了
 * 12 份。这个 module 把循环骨架收敛为一次实现，子命令只声明差异：
 *
 *   - progress / log / failed 有合理的缺省渲染，多数命令不用写
 *   - result 必填——每个子命令真正不同的只有这一处
 *
 * ADR-0001 说 consumer 之间不共享代码；这是 consumer *内部*的 module，
 * MCP 侧将来自己长出同名的 seam，互不共享。
 */
import type { OpEvent } from '../core/events.js'
import type { Operation } from '../core/operation.js'

export const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Ctrl+C → abort。11 个子命令的同一行样板。 */
export function createInterrupt(): AbortController {
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())
  return controller
}

export interface OpUi<T> {
  /** 缺省：单行刷新 `\r{done}/{total}  {label}` */
  progress?(ev: Extract<OpEvent<never>, { type: 'progress' }>): void
  /** 缺省：dim `· code`。返回前自行决定输出到哪路。 */
  log?(ev: Extract<OpEvent<never>, { type: 'log' }>): void
  /** 缺省：红 `code: message` + dim hint */
  failed?(ev: Extract<OpEvent<never>, { type: 'failed' }>): void
  /** 必填：渲染最终结果并映射为退出码 */
  result(value: T): number
}

/**
 * 跑完一个 Operation 并渲染。返回退出码。
 *
 * 没拿到 result 就结束（比如被 abort）返回 1——与各子命令原先的兜底一致。
 */
export async function consume<T>(
  op: Operation<T>,
  ui: OpUi<T>,
  signal: AbortSignal,
): Promise<number> {
  for await (const ev of op.run(signal)) {
    switch (ev.type) {
      case 'progress':
        if (ui.progress !== undefined) {
          ui.progress(ev)
        } else if (process.stderr.isTTY === true) {
          process.stderr.write(`\r${C.dim}${ev.done}/${ev.total}  ${ev.label}${C.reset}   `)
          if (ev.done === ev.total) process.stderr.write('\r')
        } else if (ev.done === ev.total) {
          // 重定向到文件/管道时没有「回车回到行首」这回事，逐条写会把整个进度
          // 糊成一行（CI 日志里就是这样）。非 TTY 只在整批结束时留一行。
          process.stderr.write(`${C.dim}${ev.done}/${ev.total}  ${ev.label}${C.reset}\n`)
        }
        break
      case 'log':
        if (ui.log !== undefined) {
          ui.log(ev)
        } else {
          process.stderr.write(`${C.dim}· ${ev.code}${C.reset}\n`)
        }
        break
      case 'result':
        return ui.result(ev.value)
      case 'failed':
        if (ui.failed !== undefined) {
          ui.failed(ev)
        } else {
          process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
          if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
        }
        return 1
      default:
        break
    }
  }
  return 1
}
