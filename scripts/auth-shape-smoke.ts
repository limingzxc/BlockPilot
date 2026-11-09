/**
 * 形状探针：用**无效令牌**打真实端点，验证请求形状被服务端接受。
 *
 * 为什么需要它：单测里的假 `HttpClient` 替换了整个 HTTP 边界，请求体少一个字段它也不知道。
 * 真实事故是 `Properties.AuthMethod` 缺失——XBL 返回 400 且响应体为空，看着像令牌失效，
 * 23 个测试全绿。这个脚本不需要账号、不需要授权，一次请求就能分辨两者：
 *
 *   形状对 → 无效令牌得到 401（令牌无效）
 *   形状错 → 400（请求本身被拒）
 *
 * 走的是生产代码（`authenticateXbl` / `loginWithXbox`），不是抄一份请求出来，
 * 所以它盯的就是线上那一行。
 *
 * 用法：npm run smoke:auth（需要网络，不进 CI）
 */
import { isAuthError } from '../src/core/auth/types.js'
import { authenticateXbl, loginWithXbox } from '../src/core/auth/xbox.js'
import { applyProxy } from '../src/core/proxy.js'

applyProxy()

const failures: string[] = []

/** 期望这次调用失败，且失败原因说明「令牌被拒」而不是「请求不合法」。 */
async function expectRejected(label: string, call: () => Promise<unknown>, accept: RegExp): Promise<void> {
  try {
    await call()
    console.log(`  ✗ ${label}  居然成功了——探针用的是无效令牌，说明服务端没在验`)
    failures.push(`${label}：无效令牌竟然成功`)
    return
  } catch (err) {
    const message = isAuthError(err) ? `${err.code} ${err.message}` : String(err)
    if (accept.test(message)) {
      console.log(`  ✓ ${label}  ${message}`)
      return
    }
    const why = /400/.test(message) ? '  ← 400 是形状问题，不是令牌问题' : ''
    console.log(`  ✗ ${label}  ${message}${why}`)
    failures.push(`${label}：${message}`)
  }
}

console.log('[shape] 真实端点 + 无效令牌：')

await expectRejected('XBL user/authenticate', () => authenticateXbl('probe-invalid-token'), /401/)

await expectRejected(
  'MC authentication/login_with_xbox',
  () => loginWithXbox({ token: 'probe-invalid-token', userHash: '1' }),
  /401|UNAUTHORIZED/,
)

/**
 * XSTS 故意不在探针里：它对无效令牌本来就返回 400 空体，与「形状错」的现象完全一致，
 * 这个办法分辨不出来。它的请求形状由单测里的整份 deepEqual 负责。
 */

if (failures.length > 0) {
  console.error('\n[shape] 失败：')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n[shape] 全部通过')
