import assert from 'node:assert/strict'
import test from 'node:test'

import { gameVersionOf } from './game-version.js'

test('加载器版本 id 也能剥出 MC 版本（issue #18）', () => {
  assert.equal(gameVersionOf('fabric-loader-0.20.1-1.6.4'), '1.6.4')
  assert.equal(gameVersionOf('quilt-loader-0.20.0-1.20.1'), '1.20.1')
  assert.equal(gameVersionOf('1.20.1-forge-47.2.0'), '1.20.1')
  assert.equal(gameVersionOf('1.6.4'), '1.6.4')
  assert.equal(gameVersionOf('26.4-snapshot-1'), undefined)
})
