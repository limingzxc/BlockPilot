import assert from 'node:assert/strict'
import test from 'node:test'

import { offlineUuid, offlineUuidHex } from './uuid.js'

test('离线 UUID 与官方 OfflinePlayer 派生一致（已知向量）', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f')
  assert.equal(offlineUuidHex('Steve'), '5627dd98e6be3c21b8a8e92344183641')
})

test('版本位是 3，变体位是 RFC 4122', () => {
  const hex = offlineUuidHex('Steve')
  assert.equal(hex.length, 32)
  assert.equal(hex[12], '3')
  assert.ok(['8', '9', 'a', 'b'].includes(hex[16] ?? ''))
})

test('同名同值、异名异值', () => {
  assert.equal(offlineUuid('Alex'), offlineUuid('Alex'))
  assert.notEqual(offlineUuid('Alex'), offlineUuid('Steve'))
})
