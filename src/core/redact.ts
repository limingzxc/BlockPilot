/**
 * 令牌脱敏。
 *
 * 启动命令里带着真实的 accessToken，`launch --raw` 会原样打印；1.6.x 的
 * `Session ID is token:<token>:<uuid>` 又会把它写进会话日志，而日志随后会被
 * `diag` 和 MCP 读给 AI。脱敏必须发生在**产出文本的那一处**，不能指望每个
 * 消费者各自记得擦。
 *
 * 只做保守替换：命中不了的模式原样保留，宁可漏一个不常见的字段，
 * 也不要把正常文本改成 `***` 让人读不懂。
 */

const MASK = '***'

/**
 * 顺序有意义：先处理带字段名的长模式，再处理 `token:` 这种裸格式。
 * 每条都要求前面有可识别的锚点（flag / 字段名 / 协议前缀），避免误伤普通文本。
 */
const RULES: readonly (readonly [RegExp, string])[] = [
  // --accessToken <value>
  [/(--accessToken\s+)(\S+)/g, `$1${MASK}`],
  // JSON / log 字段："accessToken":"..."
  [/("accessToken"\s*:\s*")([^"]*)(")/g, `$1${MASK}$3`],
  // Authorization: Bearer ...
  [/(Authorization:\s*Bearer\s+)(\S+)/gi, `$1${MASK}`],
  // 1.6.x 会话日志：Session ID is token:<accessToken>:<uuid>
  [/(\btoken:)([^:\s]+)(:[0-9a-fA-F][0-9a-fA-F-]{31,35})/g, `$1${MASK}$3`],
]

/** 把一段文本里的令牌替换成 `***`。幂等：已经脱敏过的文本不会被再次改写。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
  return out
}

/** 参数数组版本。启动命令展示用：`--accessToken` 与它的值是两个元素，要成对处理。 */
export function redactArgs(args: readonly string[]): string[] {
  const out = [...args]
  for (let i = 0; i < out.length; i += 1) {
    const arg = out[i] ?? ''
    if (arg === '--accessToken' && i + 1 < out.length) {
      out[i + 1] = MASK
      i += 1
      continue
    }
    out[i] = redactSecrets(arg)
  }
  return out
}
