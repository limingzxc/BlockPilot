import assert from 'node:assert/strict'
import test from 'node:test'
import type { VersionInfo } from '../content-source.js'
import type { ClosureResult } from '../deps/closure.js'
import { closureToFindings } from './closure-findings.js'

const resolvedB: VersionInfo = {
  projectId: 'b',
  versionId: 'b-1',
  name: 'b display',
  gameVersions: ['1.20.1'],
  loaders: ['fabric'],
  dependencies: [],
  files: [],
}

function closure(over: Partial<ClosureResult> = {}): ClosureResult {
  return { visited: [], missing: [], cycles: [], truncated: false, ...over }
}

test('找到可安装版本 → MISSING_DEPENDENCY，hint 带版本名', () => {
  const findings = closureToFindings(
    closure({ missing: [{ projectId: 'b', requiredBy: ['a'], resolved: resolvedB }] }),
  )
  const f = findings.find((x) => x.code === 'MISSING_DEPENDENCY')
  assert.ok(f)
  assert.equal(f.severity, 'blocker')
  assert.match(f.hint ?? '', /b display/)
})

test('给了 nameOf：文案用名字，subject 仍是 id', () => {
  // 真实场景：Homestead 里「TIo1UXXV 需要前置模组 ordsPcFz」，两个都是裸 id
  const names = new Map([
    ['TIo1UXXV', 'Hybrid Aquamirai'],
    ['ordsPcFz', 'KotlinLangForge'],
  ])
  const findings = closureToFindings(
    closure({ missing: [{ projectId: 'ordsPcFz', requiredBy: ['TIo1UXXV'], resolved: null }] }),
    { verified: false, nameOf: (id) => names.get(id) },
  )
  const f = findings[0]
  assert.ok(f)
  assert.match(f.message, /KotlinLangForge \(ordsPcFz\)/)
  assert.match(f.message, /Hybrid Aquamirai \(TIo1UXXV\)/)
  // 机器码字段不跟着变：脚本按 subject 反查
  assert.equal(f.subject, 'ordsPcFz')
})

test('找不到兼容版本 → UNSATISFIABLE_DEPENDENCY', () => {
  const findings = closureToFindings(
    closure({ missing: [{ projectId: 'ghost', requiredBy: ['a'], resolved: null }] }),
  )
  assert.ok(findings.some((f) => f.code === 'UNSATISFIABLE_DEPENDENCY'))
})

test('循环依赖 → DEPENDENCY_CYCLE', () => {
  const findings = closureToFindings(closure({ cycles: [['a', 'b', 'c', 'b']] }))
  const f = findings.find((x) => x.code === 'DEPENDENCY_CYCLE')
  assert.ok(f)
  assert.equal(f.severity, 'warning')
  assert.equal(f.subject, 'a')
})

test('截断 → CLOSURE_TRUNCATED，且不允许说 ok', () => {
  const findings = closureToFindings(closure({ truncated: true }))
  assert.ok(findings.some((f) => f.code === 'CLOSURE_TRUNCATED' && f.severity === 'warning'))
})

test('整合包模式（verified=false）：缺依赖降级为 warning，不说成「不存在」', () => {
  const findings = closureToFindings(
    closure({ missing: [{ projectId: 'b', requiredBy: ['a'], resolved: resolvedB }] }),
    { verified: false },
  )
  assert.equal(findings.length, 1)
  const f = findings[0]
  assert.equal(f?.code, 'UNVERIFIED_DEPENDENCY')
  assert.equal(f?.severity, 'warning')
  assert.match(f?.message ?? '', /可能已内置/)
})
