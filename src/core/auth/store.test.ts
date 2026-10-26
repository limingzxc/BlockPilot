import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { authStorePath, loadStore, pickAccount, removeAccount, saveStore, upsertAccount } from './store.js'
import { AuthError, type AuthAccount } from './types.js'

function acc(uuid: string, name: string): AuthAccount {
  return {
    uuid,
    name,
    accessToken: 'at',
    expiresAt: 9_999_999_999_999,
    obtainedAt: 1,
    userType: 'msa',
  }
}

const A = acc('069a79f444e94726a5befca90e38aaf5', 'Notch')
const B = acc('11111111111111111111111111111111', 'Steve')

function withDir(fn: (dir: string, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-store-'))
  try {
    fn(dir, authStorePath(dir))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('存档路径固定在 <root>/auth/accounts.json', () => {
  assert.equal(authStorePath(join('D:', 'mc')), join('D:', 'mc', 'auth', 'accounts.json'))
})

test('upsert 同 uuid 覆盖而不重复，并设为当前', () => {
  withDir((_, path) => {
    upsertAccount(path, A)
    upsertAccount(path, { ...B, uuid: A.uuid, name: 'Notch2' })
    const store = loadStore(path)
    assert.equal(store.accounts.length, 1)
    assert.equal(store.accounts[0]?.name, 'Notch2')
    assert.equal(store.active, A.uuid)
  })
})

test('pickAccount：按名字大小写不敏感，按 uuid 也认，缺省取 active', () => {
  withDir((_, path) => {
    upsertAccount(path, A)
    upsertAccount(path, B)
    const store = loadStore(path)
    assert.equal(pickAccount(store, 'notch')?.uuid, A.uuid)
    assert.equal(pickAccount(store, A.uuid.toUpperCase())?.uuid, A.uuid)
    assert.equal(pickAccount(store, A.uuid.slice(0, 8) + '-' + A.uuid.slice(8))?.uuid, A.uuid)
    assert.equal(pickAccount(store)?.uuid, B.uuid, '最后写入的是 active')
    assert.equal(pickAccount(store, 'nobody'), null)
  })
})

test('removeAccount：删掉 active 后自动指向剩下的第一个', () => {
  withDir((_, path) => {
    upsertAccount(path, A)
    upsertAccount(path, B)
    assert.equal(removeAccount(path, 'Steve'), true)
    const store = loadStore(path)
    assert.equal(store.accounts.length, 1)
    assert.equal(store.active, A.uuid)
    assert.equal(removeAccount(path, 'Steve'), false)
  })
})

test('损坏的 JSON 报 AUTH_STORE_CORRUPT，提示可以删掉', () => {
  withDir((_, path) => {
    saveStore(path, { accounts: [] })
    writeFileSync(path, '{ not json')
    assert.throws(
      () => loadStore(path),
      (err: unknown) => {
        assert.ok(err instanceof AuthError)
        assert.equal(err.code, 'AUTH_STORE_CORRUPT')
        assert.match(err.hint ?? '', /删掉/)
        return true
      },
    )
  })
})

test('形状不完整的条目被过滤，不拖垮整个文件', () => {
  withDir((_, path) => {
    saveStore(path, { accounts: [] })
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        active: A.uuid,
        accounts: [A, { uuid: 'short', name: 'bad' }, { uuid: B.uuid }],
      }),
    )
    const store = loadStore(path)
    assert.equal(store.accounts.length, 1)
    assert.equal(store.accounts[0]?.uuid, A.uuid)
  })
})

test('写入是原子的：不留 .tmp，且文件可被再次解析', () => {
  withDir((dir, path) => {
    upsertAccount(path, A)
    assert.equal(existsSync(`${path}.tmp`), false)
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { version: number }
    assert.equal(parsed.version, 1)
    assert.ok(dir.length > 0)
  })
})

test('空存档：没有账号也不报错', () => {
  withDir((_, path) => {
    const store = loadStore(path)
    assert.deepEqual(store.accounts, [])
    assert.equal(pickAccount(store), null)
  })
})
