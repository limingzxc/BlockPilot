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
  const issues = checkLocalDeps([mod('sodium', [['fabric-rendering-fluids-v1', true]])])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.modId, 'fabric-rendering-fluids-v1')
})

test('多个模组依赖同一个缺失项时合并 requiredBy', () => {
  const issues = checkLocalDeps([mod('a', [['shared', true]]), mod('b', [['shared', true]])])
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

test('Forge 的裸版本号不构成限制（citadel_fix 要求 1.0.0、实际 2.6.1）', () => {
  const citadel = {
    modId: 'citadel',
    version: '2.6.1',
    provides: [],
    nested: [],
    dependencies: [],
    loader: 'forge' as const,
  }
  const fix = {
    modId: 'citadel_fix',
    version: '1.2',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'citadel', mandatory: true, versionRange: '1.0.0' }],
    loader: 'forge' as const,
  }
  assert.equal(checkLocalDeps([citadel, fix]).length, 0)

  // Fabric 同一份写法是精确匹配，仍然要报
  const fabricFix = { ...fix, loader: 'fabric' as const }
  const fabricCitadel = { ...citadel, loader: 'fabric' as const }
  const issues = checkLocalDeps([fabricCitadel, fabricFix])
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.kind, 'version')
})

test('同名 modId 在 JiJ 里有多份时取最高版本', () => {
  // Prominence II：flywheel 没有顶层 jar，create 里是 1.0.5、estrogen 里是 1.0.2
  const create = {
    modId: 'create',
    version: '6.0.8',
    provides: [],
    nested: [{ modId: 'flywheel', version: '1.0.5+1.20.1.build.264' }],
    dependencies: [{ modId: 'flywheel', mandatory: true, versionRange: '>=1.0.5-264' }],
    loader: 'fabric' as const,
  }
  const estrogen = {
    modId: 'estrogen',
    version: '5.0.8',
    provides: [],
    nested: [{ modId: 'flywheel', version: '1.0.2+1.20.1' }],
    dependencies: [],
    loader: 'fabric' as const,
  }
  assert.equal(checkLocalDeps([create, estrogen]).length, 0)
  // 顺序反过来也不能变（以前「最后读到的那份」说了算）
  assert.equal(checkLocalDeps([estrogen, create]).length, 0)
})

test('顶层 jar 优先于 JiJ 里的副本（cloth-config 顶层 11.1.136 vs 嵌套 13.0.121）', () => {
  const cloth = {
    modId: 'cloth-config',
    version: '11.1.136',
    provides: [],
    nested: [],
    dependencies: [],
    loader: 'fabric' as const,
  }
  const quartz = {
    modId: 'quartz-elevator',
    version: '1.0',
    provides: [],
    nested: [{ modId: 'cloth-config', version: '13.0.121' }],
    dependencies: [],
    loader: 'fabric' as const,
  }
  const yigd = {
    modId: 'yigd',
    version: '2.0',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'cloth-config', mandatory: true, versionRange: '^11.0.0' }],
    loader: 'fabric' as const,
  }
  assert.equal(checkLocalDeps([cloth, quartz, yigd]).length, 0)
})

test('Forge 的 provides 与下划线拼写能匹配 Fabric 风格的依赖', () => {
  // BMC4：modId 是 fabric_api，provides 里写着 fabric / fabric-api，
  // 而依赖方（Fabric 模组）写的是 fabric-api
  const forgified = {
    modId: 'fabric_api',
    version: '0.92.6+1.11.14+1.20.1',
    provides: ['fabric', 'fabric-api'],
    nested: [],
    dependencies: [],
    loader: 'forge' as const,
  }
  const consumer = {
    modId: 'autochefsdelight',
    version: '1.0',
    provides: [],
    nested: [],
    dependencies: [{ modId: 'fabric-api', mandatory: true }],
    loader: 'fabric' as const,
  }
  assert.equal(checkLocalDeps([forgified, consumer]).length, 0)

  // 连 modId 本身的大小写/下划线差异也要容忍
  const connector = {
    ...forgified,
    modId: 'Sinytra_Connector',
    provides: [],
  }
  const needsConnector = {
    ...consumer,
    dependencies: [{ modId: 'sinytra-connector', mandatory: true }],
  }
  assert.equal(checkLocalDeps([connector, needsConnector]).length, 0)
})
