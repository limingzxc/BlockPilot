import { BlockPilotError } from './errors.js'
import { USER_AGENT } from './user-agent.js'

/**
 * 网络层失败。
 *
 * 原生 `fetch` 抛的 `TypeError: fetch failed` 不带 URL、不带原因，用户看到这行
 * 无从下手——「哪个地址失败了？是墙、DNS、还是对方 500？」。所有出网的 JSON
 * 请求都走这里，错误信息至少包含地址与底层原因。
 */
export class NetworkError extends BlockPilotError {
  readonly url: string

  constructor(url: string, detail: string) {
    // 查询串可能有几十个 id，截断后再进消息，否则一行日志能占满屏幕
    const shown = url.length > 120 ? `${url.slice(0, 117)}...` : url
    super('NETWORK_ERROR', `无法访问 ${shown}：${detail}`)
    this.name = 'NetworkError'
    this.url = url
  }
}

export interface JsonRequest {
  readonly signal?: AbortSignal
  /** 额外请求头，会覆盖默认值 */
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

const TIMEOUT_MS = 20_000

/** GET 一个 JSON。传输失败抛 NetworkError；HTTP 非 2xx 抛普通 Error（带状态码）。 */
export async function fetchJson<T>(url: string, opts: JsonRequest = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...opts.headers },
      signal: AbortSignal.any([
        AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
        ...(opts.signal === undefined ? [] : [opts.signal]),
      ]),
    })
  } catch (err) {
    // 用户主动取消保持原样：调用方靠 signal.aborted 判断，不该被包成网络故障
    if (opts.signal?.aborted === true) throw err
    throw new NetworkError(url, detailOf(err))
  }

  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch {
    throw new NetworkError(url, '返回的不是 JSON')
  }
}

function detailOf(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  if (err.name === 'TimeoutError') return '请求超时'
  const cause = (err as { readonly cause?: unknown }).cause
  if (cause instanceof Error && cause.message !== '') return cause.message
  return err.message
}
