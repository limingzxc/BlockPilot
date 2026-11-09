import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_CLIENT_ID, resolveClientId } from './app.js'

test('resolveClientId：什么都没给时用内置的 BlockPilot 应用', () => {
  assert.equal(resolveClientId(), DEFAULT_CLIENT_ID)
  assert.equal(resolveClientId({ flag: undefined, env: undefined }), DEFAULT_CLIENT_ID)
})

test('resolveClientId：环境变量覆盖内置值', () => {
  assert.equal(resolveClientId({ env: 'env-id' }), 'env-id')
})

test('resolveClientId：命令行参数优先级最高', () => {
  assert.equal(resolveClientId({ flag: 'flag-id', env: 'env-id' }), 'flag-id')
})

test('resolveClientId：空串与纯空白按「没给」处理，不产生空 id', () => {
  assert.equal(resolveClientId({ flag: '', env: 'env-id' }), 'env-id')
  assert.equal(resolveClientId({ flag: '  ', env: '   ' }), DEFAULT_CLIENT_ID)
})

test('resolveClientId：两侧空白被去掉——粘贴时最容易带上换行', () => {
  assert.equal(resolveClientId({ flag: ' flag-id\n' }), 'flag-id')
})
