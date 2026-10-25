import assert from 'node:assert/strict'
import { test } from 'node:test'

import { checkLocalDeps } from './localDeps.js'

function mod(modId: string, deps: Array<[string, boolean]> = [], provides: string[] = []) {
  return {
    modId,
    provides,
    dependencies: deps.map(([id, mandatory]) => ({ modId: id, mandatory })),
  }
}

test('缺必需依赖被报出来', () => {
  const issues = checkLocalDeps([mod('iris', [['sodium', true]])])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.modId, 'sodium')
  assert.deepEqual(issues[0]?.requiredBy, ['iris'])
})

test('optional 依赖不报', () => {
  const issues = checkLocalDeps([mod('a', [['b', false]])])
  assert.equal(issues.length, 0)
})

test('虚拟 id 不算缺失', () => {
  const issues = checkLocalDeps([
    mod('a', [
      ['minecraft', true],
      ['fabricloader', true],
      ['java', true],
    ]),
  ])
  assert.equal(issues.length, 0)
})

test('provides 能满足子模块依赖（Fabric API 场景）', () => {
  const fabricApi = mod(
    'fabric-api',
    [],
    ['fabric-rendering-fluids-v1', 'fabric-rendering-data-attachment-v1'],
  )
  const sodium = mod('sodium', [
    ['fabric-rendering-fluids-v1', true],
    ['fabric-rendering-data-attachment-v1', true],
  ])
  const issues = checkLocalDeps([fabricApi, sodium])
  assert.equal(issues.length, 0, '装了 fabric-api 就不该报缺子模块')
})

test('没有 provides 时报子模块缺失', () => {
  const issues = checkLocalDeps([
    mod('sodium', [['fabric-rendering-fluids-v1', true]]),
  ])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.modId, 'fabric-rendering-fluids-v1')
})

test('多个模组依赖同一个缺失项时合并 requiredBy', () => {
  const issues = checkLocalDeps([
    mod('a', [['shared', true]]),
    mod('b', [['shared', true]]),
  ])
  assert.equal(issues.length, 1)
  assert.deepEqual([...(issues[0]?.requiredBy ?? [])].sort(), ['a', 'b'])
})
