import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Instance } from '../instance.js'
import type { VersionInfo } from '../sources.js'
import { checkInstance, checkJava } from './check.js'
import { requiredJavaMajor } from '../java/types.js'

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

test('模组比游戏老 → VERSION_UNVERIFIED (warning)，不是 blocker', () => {
  // ADR-0026：目标 26.2，模组只勾到 26.1.2。作者可能只是没补勾
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'mixintrace', versionId: 'a1', gameVersions: ['26.1', '26.1.1', '26.1.2'] })],
  ])
  const findings = checkInstance({
    instance: instance({
      gameVersion: '26.2',
      mods: [{ projectId: 'mixintrace', versionId: 'a1', source: 'modrinth', fileName: 'mods/mixintrace.jar' }],
    }),
    versions,
  })
  const f = findings.find((x) => x.code === 'VERSION_UNVERIFIED')
  assert.ok(f)
  assert.equal(f.severity, 'warning')
  assert.ok(!findings.some((x) => x.code === 'VERSION_MISMATCH'))
})

test('模组比游戏新 → VERSION_MISMATCH (blocker)', () => {
  // 目标 1.20.1，模组最低要求 1.21：用到的 API 在那个版本里可能不存在，必崩
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'x', versionId: 'a1', gameVersions: ['1.21', '1.21.1'] })],
  ])
  const findings = checkInstance({
    instance: instance({
      gameVersion: '1.20.1',
      mods: [{ projectId: 'x', versionId: 'a1', source: 'modrinth', fileName: 'mods/x.jar' }],
    }),
    versions,
  })
  const f = findings.find((x) => x.code === 'VERSION_MISMATCH')
  assert.ok(f)
  assert.equal(f.severity, 'blocker')
})

test('目标版本落在声明区间中间但没勾 → 仍按 blocker', () => {
  const versions = new Map<string, VersionInfo>([
    ['a1', v({ projectId: 'x', versionId: 'a1', gameVersions: ['1.20.1', '1.21.1'] })],
  ])
  const findings = checkInstance({
    instance: instance({
      gameVersion: '1.20.4',
      mods: [{ projectId: 'x', versionId: 'a1', source: 'modrinth', fileName: 'mods/x.jar' }],
    }),
    versions,
  })
  assert.ok(findings.some((f) => f.code === 'VERSION_MISMATCH' && f.severity === 'blocker'))
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
  // 日历版 26.x 的版本 JSON 全部写 majorVersion 25（java-runtime-epsilon）
  assert.equal(requiredJavaMajor('26.2'), 25)
  assert.equal(requiredJavaMajor('26.3'), 25)
})

test('Java：缺 Java 25 时提示要装的是 25，不是 21', () => {
  const findings = checkJava(instance({ gameVersion: '26.2' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [21],
  })
  const f = findings.find((x) => x.code === 'JAVA_MISSING')
  assert.ok(f)
  assert.match(f.message, /Java 25/)
  assert.match(f.hint ?? '', /java install 25/)
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

test('Java：1.12.2 只有 Java 21 → JAVA_TOO_NEW (blocker)，不能说「多数能启动」', () => {
  // 老 Forge 在 Java 9+ 上起不来。给 warning 会让人白跑一次再回来
  const findings = checkJava(instance({ gameVersion: '1.12.2' }), {
    os: 'windows',
    totalMemoryMiB: 16384,
    javaMajors: [21],
  })
  const f = findings.find((x) => x.code === 'JAVA_TOO_NEW')
  assert.ok(f)
  assert.equal(f.severity, 'blocker')
  assert.match(f.hint ?? '', /java install 8/)
  assert.ok(!findings.some((x) => x.code === 'JAVA_NEWER_ONLY'))
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

test('Java：mod 声明 java >=17 <=21 时，不再建议装 Java 8（issue #11）', () => {
  // BTWCE：MC 1.6.4 + Legacy Fabric，fabric.mod.json 写着 "java": ">=17 <=21"
  const findings = checkJava(
    instance({ gameVersion: '1.6.4' }),
    { os: 'windows', totalMemoryMiB: 8192, javaMajors: [8] },
    [{ modId: 'btwce', range: '>=17 <=21' }],
  )
  // 兜底表会算成 1.6.4 → Java 8，本机正好有 8，于是「一切正常」——但 mod 不认
  const bad = findings.find((f) => f.code === 'JAVA_INCOMPATIBLE_WITH_MOD')
  assert.ok(bad, '要报 JAVA_INCOMPATIBLE_WITH_MOD')
  assert.equal(bad.severity, 'blocker')
  assert.match(bad.message, /btwce 要求 Java >=17 <=21/)
  assert.match(bad.hint ?? '', /java install 17/)
  assert.doesNotMatch(bad.hint ?? '', /java install 8\b/)
  // 不能再出现与 mod 声明矛盾的建议
  assert.equal(findings.some((f) => f.code === 'JAVA_TOO_NEW' || f.code === 'JAVA_NEWER_ONLY'), false)
})

test('Java：宿主已满足 mod 声明的范围就不报', () => {
  const findings = checkJava(
    instance({ gameVersion: '1.6.4' }),
    { os: 'windows', totalMemoryMiB: 8192, javaMajors: [17, 21] },
    [{ modId: 'btwce', range: '>=17 <=21' }],
  )
  assert.equal(findings.length, 0)
})
