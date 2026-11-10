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
import { redactArgs, redactSecrets } from '../core/redact.js'

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

/**
 * 全局 `--events` 开关。
 *
 * 事件流是给自动化消费者的：每行一个 JSON 事件，最后一行是 exit code。
 * 人类渲染完全关掉，stdout 里不会混进进度条或颜色。
 */
let eventStream = false

export function setEventStream(on: boolean): void {
  eventStream = on
}

export function isEventStream(): boolean {
  return eventStream
}

/**
 * 人类文本的出口。
 *
 * `--events` 的契约是「stdout 只有 ndjson」。子命令里散落的
 * `process.stdout.write` 会在事件流之前/之间混进人类文本，消费者解析第一行就炸；
 * 所以统一走这里：事件模式下改道 stderr，既不丢信息，也不污染协议。
 */
export function say(text: string): void {
  if (eventStream) process.stderr.write(text)
  else process.stdout.write(text)
}

/** 在事件流里补一条 failed。只给「还没进入 Operation 就失败」的路径用。 */
export function emitFailed(code: string, message: string, hint?: string): void {
  if (!eventStream) return
  const payload = {
    schemaVersion: 1,
    type: 'failed',
    code,
    message: redactSecrets(message),
    ...(hint === undefined ? {} : { hint: redactSecrets(hint) }),
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

let exitEmitted = false

/** 写 `exit` 行。整个进程只允许一行，重复调用返回 false。 */
export function emitExit(code: number): boolean {
  if (exitEmitted) return false
  exitEmitted = true
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'exit', code })}\n`)
  return true
}

/** 事件流兜底脱敏。导出只给测试：证明 result 也不会漏令牌。 */
export function sanitizeEventValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    // JSON 里的 accessToken / refreshToken 字段按 key 处理；其余文本走通用规则
    if (key === 'accessToken' || key === 'refreshToken') return '***'
    return redactSecrets(value)
  }
  if (Array.isArray(value)) {
    // 启动命令是数组：`--accessToken` 与它的值是两个元素，必须成对脱敏
    if (key === 'args') return redactArgs(value.filter((v): v is string => typeof v === 'string'))
    return value.map((item) => sanitizeEventValue(item))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeEventValue(v, k)
    }
    return out
  }
  return value
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
  /**
   * `--events` 模式下只算退出码、不渲染。
   * 缺省 0；preflight / diag / verify / deploy 这类有非零结论的命令必须给。
   */
  exitCode?(value: T): number
  /**
   * `--events` 模式下只要结果值、不要渲染。
   *
   * 串联多个 Operation 的命令（install / run）要在中间步骤拿到 result 继续编排；
   * 非事件模式下走 `result`，这里只在事件模式下补一次捕获。
   */
  capture?(value: T): void
  /**
   * `--events` 模式是否在本次 Operation 结束时写 `exit` 行。
   *
   * 串联多个 Operation 的命令（run / install / forge）只有最后一步该写；
   * 前几步传 false，由调用方在真正结束时统一写。
   */
  readonly exitEvent?: boolean
}

/** `consumeValue` 的结果：退出码 + 中间 Operation 的 result。 */
export interface ConsumedValue<T> {
  readonly code: number
  readonly value: T | undefined
}

/**
 * 串联命令专用：跑完中间 Operation，拿到 result 继续编排。
 *
 * 不要直接 `consume` 再手写 `result`/`capture`——事件模式下 `consume` 只发事件、
 * 不调用 `result`，忘记 `capture` 就会静默拿不到值并提前返回 1（install/run
 * 都踩过一次）。这里把两种模式的捕获收在一处，调用方只关心返回值。
 */
export async function consumeValue<T>(
  op: Operation<T>,
  ui: Omit<OpUi<T>, 'result' | 'capture'>,
  signal: AbortSignal,
): Promise<ConsumedValue<T>> {
  let value: T | undefined
  const code = await consume(
    op,
    {
      ...ui,
      result: (v) => {
        value = v
        return ui.exitCode?.(v) ?? 0
      },
      capture: (v) => {
        value = v
      },
    },
    signal,
  )
  return { code, value }
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
  const emit = (payload: object): void => {
    const clean = sanitizeEventValue(payload) as Record<string, unknown>
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...clean })}\n`)
  }

  for await (const ev of op.run(signal)) {
    if (eventStream) {
      emit(ev)
      if (ev.type === 'result') {
        ui.capture?.(ev.value)
        const code = ui.exitCode?.(ev.value) ?? 0
        if (ui.exitEvent !== false) emitExit(code)
        return code
      }
      if (ev.type === 'failed') {
        if (ui.exitEvent !== false) emitExit(1)
        return 1
      }
      continue
    }

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
  if (eventStream && ui.exitEvent !== false) emitExit(1)
  return 1
}
