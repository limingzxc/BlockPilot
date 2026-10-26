import { USER_AGENT } from '../user-agent.js'
import { authError } from './types.js'

/**
 * 认证用的 HTTP 抽象。
 *
 * 为什么单独抽一层而不是直接 fetch：
 * 整条链有 5 次请求，每次都要带 UA、超时、解析 JSON、把网络错误翻译成
 * 可操作的失败。散在 5 个函数里会有 5 份略有差异的实现——测试要模拟
 * 「XSTS 返回 2148916238」，就得去 stub 全局 fetch 并手搓 Response。
 *
 * 两个 adapter：`createHttp()` 是真 fetch，测试里传一个记录调用的对象。
 */
export interface HttpResult {
  readonly status: number
  /** 已解析的 JSON；不是 JSON 时是原始文本 */
  readonly body: unknown
}

export interface HttpClient {
  postForm(
    url: string,
    fields: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<HttpResult>
  postJson(
    url: string,
    json: unknown,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<HttpResult>
  getJson(
    url: string,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<HttpResult>
}

const TIMEOUT_MS = 20_000

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    // 网关错误页是 HTML。原样带出去，比假装是 JSON 好排查
    return text
  }
}

async function send(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  try {
    const res = await fetch(url, { ...init, signal: combined })
    return { status: res.status, body: await readBody(res) }
  } catch (err) {
    // 用户取消与网络故障必须区分：前者不是错误，后者要提示换网络
    if (signal?.aborted === true) {
      throw authError('AUTH_ABORTED', '登录已取消')
    }
    if (timeout.aborted) {
      throw authError('AUTH_NETWORK', `请求超时（${TIMEOUT_MS / 1000}s）：${url}`)
    }
    const message = err instanceof Error ? err.message : String(err)
    throw authError('AUTH_NETWORK', `请求失败：${message}`)
  }
}

export function createHttp(): HttpClient {
  return {
    postForm: (url, fields, signal) =>
      send(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
          },
          body: new URLSearchParams(fields).toString(),
        },
        signal,
      ),
    postJson: (url, json, signal, headers) =>
      send(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            Accept: 'application/json',
            ...headers,
          },
          body: JSON.stringify(json),
        },
        signal,
      ),
    getJson: (url, signal, headers) =>
      send(
        url,
        {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
        },
        signal,
      ),
  }
}

/** 从任意形状的响应体里安全地取字符串字段。 */
export function str(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const v = (body as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/** 从任意形状的响应体里安全地取数字字段。 */
export function num(body: unknown, key: string): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const v = (body as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : undefined
}
