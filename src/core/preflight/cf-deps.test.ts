import assert from 'node:assert/strict'
import test from 'node:test'

import type { Instance } from '../instance.js'
import type { VersionInfo } from '../sources.js'
import { cfDependencyFindings } from './cf-deps.js'

function instance(projectIds: readonly string[]): Instance {
  return {
    id: 'p',
    name: 'p',
    gameVersion: '1.12.2',
    loader: { kind: 'forge', version: '14.23.5.2860' },
    mods: projectIds.map((id) => ({
      source: 'curseforge' as const,
      projectId: id,
      versionId: `${id}0`,
      fileName: `project-${id}.jar`,
    })),
  }
}

function info(projectId: string, name: string, required: readonly string[]): VersionInfo {
  return {
    projectId,
    versionId: `${projectId}0`,
    name,
    gameVersions: ['1.12.2'],
    loaders: ['forge'],
    dependencies: required.map((id) => ({
      projectId: id,
      versionId: null,
      kind: 'required' as const,
    })),
    files: [],
  }
}

test('声明了 required 但清单里没有 → UNVERIFIED_DEPENDENCY（warning，不是 blocker）', () => {
  const findings = cfDependencyFindings(instance(['1', '2']), [
    info('1', 'Bountiful', ['999']),
    info('2', 'Other', ['1']),
  ])
  assert.equal(findings.length, 1)
  const f = findings[0]
  assert.equal(f?.code, 'UNVERIFIED_DEPENDENCY')
  assert.equal(f?.severity, 'warning')
  assert.equal(f?.subject, '999')
  assert.match(f?.message ?? '', /Bountiful/)
  // 依赖项目名已知时要用名字，不是裸 id
  assert.match(f?.message ?? '', /999/, '清单里没有它，只能给 id')
})

test('依赖在清单里就不报；多个模组依赖同一个缺失项时合并', () => {
  assert.equal(cfDependencyFindings(instance(['1', '2']), [info('1', 'A', ['2'])]).length, 0)

  const merged = cfDependencyFindings(instance(['1', '2']), [
    info('1', 'A', ['999']),
    info('2', 'B', ['999']),
  ])
  assert.equal(merged.length, 1, '同一个缺失项只报一条')
  assert.match(merged[0]?.message ?? '', /A、B|B、A/)
})
