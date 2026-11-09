/**
 * 库入口的烟测。
 *
 * 这个文件不测业务，只保证 `package.json` 的 `exports` 指向的入口真的能 import，
 * 且关键符号没有在重构中被改名/删掉。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { BlockPilotError, createVerify, Op, resolveLayout } from './index.js'

test('库入口导出 Operation 原语与布局', () => {
  const layout = resolveLayout('/tmp/blockpilot-entry', 'x')
  assert.equal(layout.instanceId, 'x')
  assert.equal(typeof Op.log, 'function')
  assert.equal(typeof createVerify, 'function')
  assert.equal(new BlockPilotError('X', 'boom').code, 'X')
})
