import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCredentialStore } from './credentials.js'

const ACCOUNT = '069a79f444e94726a5befca90e38aaf5'
const SECRET = 'refresh-token-秘密'

/** PowerShell 本身能不能跑。与「DPAPI 是否可用」是两件事，这里只排掉受限环境。 */
function powershellUsable(): boolean {
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
    return true
  } catch {
    return false
  }
}

test('Windows DPAPI：加密写入后能读回，删除后读不到', {
  skip: process.platform !== 'win32',
}, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-cred-'))
  try {
    const store = createCredentialStore(dir)
    assert.ok(store, 'Windows 上应返回 DPAPI 后端')

    /**
     * CI 的 windows runner 上 `powershell.exe` 冷启动偶尔超过超时（实测 10 秒被杀），
     * 那时 `set` 返回 false —— 是环境慢，不是 DPAPI 坏了。重试一次；
     * 仍然失败时先确认 PowerShell 能不能跑，跑不动就跳过，别把环境问题报成回归。
     */
    let ok = store.set(ACCOUNT, SECRET)
    if (!ok) ok = store.set(ACCOUNT, SECRET)
    if (!ok) {
      if (!powershellUsable()) {
        t.skip('这台机器上 powershell.exe 不可用')
        return
      }
      assert.fail('PowerShell 可用，但 DPAPI 加密失败')
    }

    assert.equal(store.get(ACCOUNT), SECRET)
    store.delete(ACCOUNT)
    assert.equal(store.get(ACCOUNT), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
