/**
 * 「查了一下」的三种结果。
 *
 * `T | null` 把两件完全不同的事压成一个值：
 * - 服务端明确回答「没有这个东西」（404 / 空列表）
 * - 根本没连上（DNS、超时、代理、5xx）
 *
 * 合并的代价是会**说错话**：断网被报成「Adoptium 没有 Java 17 的构建」，
 * 用户会去换版本而不是查网络。ADR-0040 起，所有对外部世界的探测都返回三态，
 * 由调用方分别映射成 `*_NOT_FOUND` 与 `NETWORK_ERROR`。
 */
export type Probe<T> =
  | { readonly status: 'found'; readonly value: T }
  | { readonly status: 'absent'; readonly detail?: string }
  | { readonly status: 'unreachable'; readonly detail: string }

export function found<T>(value: T): Probe<T> {
  return { status: 'found', value }
}

export function absent(detail?: string): Probe<never> {
  return detail === undefined ? { status: 'absent' } : { status: 'absent', detail }
}

export function unreachable(detail: string): Probe<never> {
  return { status: 'unreachable', detail }
}

/** HTTP 状态码 → 三态。2xx 由调用方自己解析，这里只负责失败那一半。 */
export function probeHttpFailure(status: number, detail?: string): Probe<never> {
  const text = detail ?? `HTTP ${status}`
  // 4xx 是「对方明确说没有」；429 与 5xx 是「这次没拿到」，不能当成不存在
  if (status >= 400 && status < 500 && status !== 429) return absent(text)
  return unreachable(text)
}

/** 人话描述，给 failed 事件用。 */
export function probeDetail(probe: Probe<unknown>): string {
  if (probe.status === 'absent') return probe.detail ?? '对方没有这个资源'
  if (probe.status === 'unreachable') return probe.detail
  return '找到了'
}
