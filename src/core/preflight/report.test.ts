/**
 * 报告装配的 interface 测试。
 *
 * 这个 module 存在的唯一理由是「折法只有一份」，所以测的就是那几条规则：
 * unknown 的触发条件、blocker 优先级、plan 的缺省。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { assembleReport } from './report.js'
import type { Finding } from './types.js'

const blocker: Finding = { severity: 'blocker', code: 'JAVA_MISSING', message: '缺 Java' }
const note: Finding = { severity: 'info', code: 'UNREADABLE_JAR', message: '没元数据' }

test('全部校验过、没有 blocker：ok', () => {
  const r = assembleReport({ findings: [note], stats: { mods: 3, resolved: 3, unresolved: 0 } })
  assert.equal(r.verdict, 'ok')
})

test('有东西没校验过：ok 降为 unknown——不是 warn，更不是 ok', () => {
  const r = assembleReport({ findings: [note], stats: { mods: 3, resolved: 2, unresolved: 1 } })
  assert.equal(r.verdict, 'unknown')
})

test('已经 blocked 就不降：blocker 比「没查全」更具体', () => {
  const r = assembleReport({ findings: [blocker], stats: { mods: 3, resolved: 2, unresolved: 1 } })
  assert.equal(r.verdict, 'blocked')
})

test('不给 plan 时是空计划，不是 undefined；target 缺省不带', () => {
  const r = assembleReport({ findings: [], stats: { mods: 0, resolved: 0, unresolved: 0 } })
  assert.deepEqual(r.plan, { installs: [], manual: [] })
  assert.equal(r.target, undefined)
})

test('generatedAt 来自注入的时钟，装配函数不直接读系统时间', () => {
  const r = assembleReport({
    findings: [],
    stats: { mods: 0, resolved: 0, unresolved: 0 },
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  })
  assert.equal(r.generatedAt, '2026-01-02T03:04:05.000Z')
})
