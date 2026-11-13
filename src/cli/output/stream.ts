/**
 * 事件流协议与人类文本出口。
 *
 * 这里是 `--events` 契约的唯一实现点：stdout 只允许 ndjson，人类文本改道 stderr。
 * 模块级可变状态 `eventStream` 只在本模块内，避免散落到各命令。
 */
import { redactArgs, redactSecrets } from '../../core/redact.js'

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
