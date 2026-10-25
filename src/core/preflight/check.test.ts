import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Instance } from '../instance.js'
import type { VersionInfo } from '../sources.js'
import { checkInstance, checkJava, requiredJavaMajor } from './check.js'

function v(partial: Partial<VersionInfo> & Pick<VersionInfo, 'projectId' | 'versionId'>): VersionInfo {
  return {
    name: partial.projectId,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [],
    ...partial,
  }
}

function instance(partial: Partial<Instance> = {}): Instance {
  return {
    id: 'test',
    name: 'test',
    gameVersion: '1.20.1',
    loader: { kind: 'fabric', version: '0.15.0' },
    mods: [],
    ...partial,
  }
}

test('干净的实例不产生 finding', () => {
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'sodium', versionId: 'a1' })],
  ])
  const findings = checkInstance({
    instance: instance({
      mods: [{ projectId: 'sodium', versionId: 'a1', source: 'modrinth', fileName: 'mods/sodium.jar' }],
    }),
    versions,
  })
  assert.equal(findings.length, 0)
})

test('游戏版本不匹配 → VERSION_MISMATCH', () => {
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'x', versionId: 'a1', gameVersions: ['1.19.2'] })],
  ])
  const findings = checkInstance({
    instance: instance({
      mods: [{ projectId: 'x', versionId: 'a1', source: 'modrinth', fileName: 'mods/x.jar' }],
    }),
    versions,
  })
  assert.ok(findings.some((f) => f.code === 'VERSION_MISMATCH'))
})

test('加载器不匹配 → LOADER_MISMATCH', () => {
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'x', versionId: 'a1', loaders: ['forge'] })],
  ])
  const findings = checkInstance({
    instance: instance({
      mods: [{ projectId: 'x', versionId: 'a1', source: 'modrinth', fileName: 'mods/x.jar' }],
    }),
    versions,
  })
  assert.ok(findings.some((f) => f.code === 'LOADER_MISMATCH'))
})

test('声明不兼容且两者都在 → DECLARED_INCOMPATIBLE', () => {
  const versions = new Map<string, VersionInfo>([
    [
      'a1',
      v({
        projectId: 'a',
        versionId: 'a1',
        dependencies: [{ projectId: 'b', versionId: null, kind: 'incompatible' }],
      }),
    ],
    ['b1', v({ projectId: 'b', versionId: 'b1' })],
  ])
  const findings = checkInstance({
    instance: instance({
      mods: [
        { projectId: 'a', versionId: 'a1', source: 'modrinth', fileName: 'mods/a.jar' },
        { projectId: 'b', versionId: 'b1', source: 'modrinth', fileName: 'mods/b.jar' },
      ],
    }),
    versions,
  })
  assert.ok(findings.some((f) => f.code === 'DECLARED_INCOMPATIBLE'))
})

test('查不到元数据 → UNRESOLVED_MOD，且不应判为 blocker', () => {
  const findings = checkInstance({
    instance: instance({
      mods: [{ projectId: 'mods/local.jar', source: 'local', fileName: 'mods/local.jar' }],
    }),
    versions: new Map(),
  })
  const f = findings.find((x) => x.code === 'UNRESOLVED_MOD')
  assert.ok(f)
  assert.equal(f.severity, 'info')
})

test('Java 大版本映射', () => {
  assert.equal(requiredJavaMajor('1.16.5'), 8)
  assert.equal(requiredJavaMajor('1.17'), 17)
  assert.equal(requiredJavaMajor('1.20.4'), 17)
  assert.equal(requiredJavaMajor('1.20.5'), 21)
  assert.equal(requiredJavaMajor('1.21.1'), 21)
  assert.equal(requiredJavaMajor('26.3'), 21)
})

test('Java：一个都不够 → JAVA_MISSING (blocker)', () => {
  const findings = checkJava(instance({ gameVersion: '1.20.1' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [8],
  })
  assert.ok(findings.some((f) => f.code === 'JAVA_MISSING' && f.severity === 'blocker'))
})

test('Java：只有更高版本 → JAVA_NEWER_ONLY (warning)，不是 blocker', () => {
  const findings = checkJava(instance({ gameVersion: '1.20.1' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [21],
  })
  const f = findings.find((x) => x.code === 'JAVA_NEWER_ONLY')
  assert.ok(f)
  assert.equal(f.severity, 'warning')
  assert.ok(!findings.some((x) => x.severity === 'blocker'))
})

test('Java：精确匹配且存在更低版本 → 只记一条 info', () => {
  const findings = checkJava(instance({ gameVersion: '1.20.1' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [8, 17],
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.code, 'JAVA_OLDER_PRESENT')
  assert.equal(findings[0]?.severity, 'info')
})

test('Java：精确匹配且无更低版本 → 无 finding', () => {
  const findings = checkJava(instance({ gameVersion: '1.20.1' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [17],
  })
  assert.equal(findings.length, 0)
})
