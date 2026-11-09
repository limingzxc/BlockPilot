import assert from 'node:assert/strict'
import test from 'node:test'

import { redactArgs, redactSecrets } from './redact.js'

const UUID = '00000000000000000000000000000000'

test('--accessToken 后面的值被替换', () => {
  assert.equal(
    redactSecrets('java -cp x --accessToken eyJhbGciOi.abc.def --version 1.20.1'),
    'java -cp x --accessToken *** --version 1.20.1',
  )
})

test('1.6.x 的 Session ID 保留 uuid，只擦令牌', () => {
  assert.equal(
    redactSecrets(`[Client thread] Session ID is token:abcdef0123456789:${UUID}`),
    `[Client thread] Session ID is token:***:${UUID}`,
  )
})

test('JSON 字段与 Bearer 头都覆盖', () => {
  assert.equal(
    redactSecrets('{"accessToken":"secret-value","name":"Steve"}'),
    '{"accessToken":"***","name":"Steve"}',
  )
  assert.equal(redactSecrets('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer ***')
})

test('不是令牌的 token: 文本保持原样', () => {
  const text = 'token:not-a-uuid'
  assert.equal(redactSecrets(text), text)
})

test('脱敏是幂等的', () => {
  const once = redactSecrets('--accessToken abc --accessToken def')
  assert.equal(redactSecrets(once), once)
})

test('redactArgs 逐个参数处理，不破坏参数边界', () => {
  assert.deepEqual(redactArgs(['--accessToken', 'abc', '--username', 'Steve']), [
    '--accessToken',
    '***',
    '--username',
    'Steve',
  ])
})
