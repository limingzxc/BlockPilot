import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DependencyKind, DependencyResolver, VersionInfo } from '../content-source.js'
import { computeClosure } from './closure.js'

function ver(projectId: string, deps: Array<[string, DependencyKind]> = []): VersionInfo {
  return {
    projectId,
    versionId: `${projectId}-v1`,
    name: `${projectId} display`,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    dependencies: deps.map(([id, kind]) => ({ projectId: id, versionId: null, kind })),
    files: [],
  }
}

function resolverOf(map: Record<string, VersionInfo | null>): DependencyResolver {
  return {
    async resolve(id: string) {
      return map[id] ?? null
    },
  }
}

const filter = { gameVersion: '1.20.1', loader: 'fabric' }
const signal = new AbortController().signal

test('单层缺失依赖，且能找到可用版本', async () => {
  const a = ver('a', [['b', 'required']])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({ b: ver('b') }),
    signal,
  })
  assert.equal(result.missing.length, 1)
  assert.equal(result.missing[0]?.projectId, 'b')
  assert.equal(result.missing[0]?.resolved?.projectId, 'b')
})

test('修复计划的 manual 项也带名字', async () => {
  const { buildRepairPlan } = await import('./plan.js')
  const a = ver('a', [['b', 'required']])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({}),
    signal,
  })
  const plan = buildRepairPlan(result, {
    verified: false,
    nameOf: (id) => (id === 'b' ? 'Bee' : undefined),
  })
  assert.equal(plan.manual[0]?.projectId, 'b')
  assert.equal(plan.manual[0]?.displayName, 'Bee')
})

test('两层递归：a → b → c，两个都要报', async () => {
  const a = ver('a', [['b', 'required']])
  const b = ver('b', [['c', 'required']])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({ b, c: ver('c') }),
    signal,
  })
  const ids = result.missing.map((m) => m.projectId).sort()
  assert.deepEqual(ids, ['b', 'c'])
})

test('已安装的依赖不重复报告', async () => {
  const a = ver('a', [['b', 'required']])
  const b = ver('b')
  const result = await computeClosure({
    roots: [a, b],
    filter,
    resolver: resolverOf({ b }),
    signal,
  })
  assert.equal(result.missing.length, 0)
})

test('optional 与 embedded 不进闭包', async () => {
  const a = ver('a', [
    ['opt', 'optional'],
    ['emb', 'embedded'],
  ])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({}),
    signal,
  })
  assert.equal(result.missing.length, 0)
})

test('循环依赖被检测到而不是无限递归', async () => {
  // a 已装在实例里，真正需要新装的是 b 和 c，而 b、c 互相依赖。
  const a = ver('a', [['b', 'required']])
  const b = ver('b', [['c', 'required']])
  const c = ver('c', [['b', 'required']])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({ b, c }),
    signal,
  })
  assert.equal(result.cycles.length, 1)
  assert.deepEqual(result.cycles[0], ['a', 'b', 'c', 'b'])
})

test('闭环依赖但两端都在实例里，不算循环', async () => {
  const a = ver('a', [['b', 'required']])
  const b = ver('b', [['a', 'required']])
  const result = await computeClosure({
    roots: [a, b],
    filter,
    resolver: resolverOf({}),
    signal,
  })
  assert.equal(result.cycles.length, 0)
  assert.equal(result.missing.length, 0)
})

test('找不到兼容版本 → UNSATISFIABLE_DEPENDENCY', async () => {
  const a = ver('a', [['ghost', 'required']])
  const result = await computeClosure({
    roots: [a],
    filter,
    resolver: resolverOf({ ghost: null }),
    signal,
  })
  assert.equal(result.missing[0]?.resolved, null)
})

test('同一个缺失依赖被多个模组引用时，requiredBy 记录全部', async () => {
  const a = ver('a', [['shared', 'required']])
  const b = ver('b', [['shared', 'required']])
  const result = await computeClosure({
    roots: [a, b],
    filter,
    resolver: resolverOf({ shared: ver('shared') }),
    signal,
  })
  assert.equal(result.missing.length, 1)
  assert.deepEqual([...(result.missing[0]?.requiredBy ?? [])].sort(), ['a', 'b'])
})

test('超出上限时截断而不是跑不完', async () => {
  const roots: VersionInfo[] = []
  const map: Record<string, VersionInfo | null> = {}
  for (let i = 0; i < 10; i++) {
    roots.push(ver(`r${i}`, [[`d${i}`, 'required']]))
    map[`d${i}`] = ver(`d${i}`, [[`e${i}`, 'required']])
    map[`e${i}`] = null
  }
  const result = await computeClosure({
    roots,
    filter,
    resolver: resolverOf(map),
    signal,
    maxResolves: 3,
  })
  assert.equal(result.truncated, true)
})

test('修复计划：未验证的安装项带 confidence，默认计划仍是 verified', async () => {
  const { buildRepairPlan } = await import('./plan.js')
  const b: VersionInfo = {
    ...ver('b'),
    files: [
      {
        filename: 'b.jar',
        url: 'https://example.invalid/b.jar',
        size: 1,
        hashes: { sha1: '00' },
        primary: true,
      },
    ],
  }
  const result = await computeClosure({
    roots: [ver('a', [['b', 'required']])],
    filter,
    resolver: resolverOf({ b }),
    signal,
  })

  assert.equal(buildRepairPlan(result).installs[0]?.confidence, 'verified')
  assert.equal(buildRepairPlan(result, { verified: false }).installs[0]?.confidence, 'unverified')
})
