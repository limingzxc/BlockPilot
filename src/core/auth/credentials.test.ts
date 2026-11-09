import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createCredentialStore } from './credentials.js'

test('Windows DPAPI：加密写入后能读回，删除后读不到', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-cred-'))
  try {
    const store = createCredentialStore(dir)
    assert.ok(store, 'Windows 上应返回 DPAPI 后端')
    assert.equal(store.set('069a79f444e94726a5befca90e38aaf5', 'refresh-token-秘密'), true)
    assert.equal(store.get('069a79f444e94726a5befca90e38aaf5'), 'refresh-token-秘密')
    store.delete('069a79f444e94726a5befca90e38aaf5')
    assert.equal(store.get('069a79f444e94726a5befca90e38aaf5'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
