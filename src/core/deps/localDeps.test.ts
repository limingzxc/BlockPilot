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

test('loader 版本不够时报告 version 问题', () => {
  const mo = {
    modId: 'fabric-api',
    version: '0.92.12',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'fabricloader', mandatory: true, versionRange: '>=0.16.10' }],
  }
  const issues = checkLocalDeps([mo], { loaderVersion: '0.15.11', gameVersion: '1.20.1' })
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.kind, 'version')
  assert.equal(issues[0]?.modId, 'fabricloader')
  assert.equal(issues[0]?.requiredRange, '>=0.16.10')
  assert.equal(issues[0]?.actualVersion, '0.15.11')
})

test('loader 版本够时通过', () => {
  const mo = {
    modId: 'a',
    version: '1.0.0',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'fabricloader', mandatory: true, versionRange: '>=0.16.10' }],
  }
  assert.equal(checkLocalDeps([mo], { loaderVersion: '0.16.14' }).length, 0)
})

test('nested 里的子模块满足依赖', () => {
  const api = {
    modId: 'fabric-api',
    version: '0.92.12',
    provides: [],
    nested: [{ modId: 'fabric-rendering-fluids-v1', version: '0.4.32' }],
    dependencies: [],
  }
  const sodium = {
    modId: 'sodium',
    version: '0.5.13',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'fabric-rendering-fluids-v1', mandatory: true }],
  }
  assert.equal(checkLocalDeps([api, sodium]).length, 0)
})

test('已装 mod 版本不满足依赖方要求', () => {
  const a = { modId: 'lib', version: '1.0.0', provides: [], nested: [], dependencies: [] }
  const b = {
    modId: 'user',
    version: '1.0.0',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'lib', mandatory: true, versionRange: '>=2.0.0' }],
  }
  const issues = checkLocalDeps([a, b])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.kind, 'version')
  assert.equal(issues[0]?.actualVersion, '1.0.0')
})
