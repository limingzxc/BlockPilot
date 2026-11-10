import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { readModMetadata } from './read.js'
import { NON_MOD_DEPENDENCY_IDS } from './types.js'

function jar(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content)
  return zipSync(entries)
}

test('读 Fabric 的 fabric.mod.json', () => {
  const buf = jar({
    'fabric.mod.json': JSON.stringify({
      schemaVersion: 1,
      id: 'iris',
      version: '1.7.6',
      name: 'Iris',
      provides: ['iris-api'],
      depends: {
        minecraft: '>=1.20.1',
        fabricloader: '>=0.14.21',
        sodium: '>=0.5.0',
      },
    }),
    'net/irisshaders/Iris.class': 'ignored',
  })
  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'iris')
  assert.equal(meta.version, '1.7.6')
  assert.equal(meta.loader, 'fabric')
  assert.equal(meta.mcVersionRange, '>=1.20.1')
  assert.deepEqual(meta.provides, ['iris-api'])
  const sodium = meta.dependencies.find((d) => d.modId === 'sodium')
  assert.ok(sodium)
  assert.equal(sodium.mandatory, true)
})

test('Fabric API 式的多 provides', () => {
  const buf = jar({
    'fabric.mod.json': JSON.stringify({
      id: 'fabric-api',
      version: '0.92.0',
      provides: ['fabric-rendering-fluids-v1', 'fabric-item-api-v1', 'fabric-networking-api-v1'],
    }),
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.provides.length, 3)
  assert.ok(meta?.provides.includes('fabric-rendering-fluids-v1'))
})

test('Fabric depends 为数组时拼成 or 表达式', () => {
  const buf = jar({
    'fabric.mod.json': JSON.stringify({
      id: 'x',
      version: '1.0.0',
      depends: { minecraft: ['1.20.1', '1.20.2'] },
    }),
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.mcVersionRange, '1.20.1 || 1.20.2')
})

test('读 Forge 的 META-INF/mods.toml', () => {
  const toml = `
modLoader="javafml"
loaderVersion="[47,)"
license="MIT"

[[mods]]
modId="create"
version="0.5.1"
displayName="Create"

[[dependencies.create]]
modId="minecraft"
mandatory=true
versionRange="[1.20.1,1.21)"

[[dependencies.create]]
modId="flywheel"
mandatory=true
versionRange="[0.6.10,)"
`
  const buf = jar({ 'META-INF/mods.toml': toml })
  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'create')
  assert.equal(meta.version, '0.5.1')
  assert.equal(meta.loader, 'forge')
  assert.equal(meta.mcVersionRange, '[1.20.1,1.21)')
  assert.ok(meta.dependencies.some((d) => d.modId === 'flywheel'))
})

test('neoforge.mods.toml 优先于 mods.toml', () => {
  const neoforgeToml = `
modLoader="javafml"
[[mods]]
modId="neomod"
version="2.0.0"

[[dependencies.neomod]]
modId="minecraft"
mandatory=true
versionRange="[1.21,)"
`
  const buf = jar({
    'META-INF/neoforge.mods.toml': neoforgeToml,
    'META-INF/mods.toml': '[[mods]]\nmodId="old"\nversion="1.0.0"\n',
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.modId, 'neomod')
  assert.equal(meta?.loader, 'neoforge')
})

test('没有元数据的 zip 返回 null', () => {
  const buf = jar({ 'readme.txt': 'not a mod' })
  assert.equal(readModMetadata(buf), null)
})

test('损坏的字节返回 null 而不是抛错', () => {
  const broken = new Uint8Array([1, 2, 3, 4, 5])
  assert.equal(readModMetadata(broken), null)
})

test('NON_MOD_DEPENDENCY_IDS 覆盖常见虚拟 id', () => {
  for (const id of ['minecraft', 'fabricloader', 'forge', 'neoforge', 'java']) {
    assert.ok(NON_MOD_DEPENDENCY_IDS.has(id), `${id} should be treated as non-mod`)
  }
})

test('读 jar-in-jar 里的嵌套模组（Fabric API 场景）', () => {
  const sub = (id: string) =>
    zipSync({
      'fabric.mod.json': strToU8(JSON.stringify({ id, version: '0.4.32+1802ada577' })),
    })
  const buf = zipSync({
    'fabric.mod.json': strToU8(
      JSON.stringify({ id: 'fabric-api', version: '0.92.12+1.20.1', provides: [] }),
    ),
    'META-INF/jars/fabric-rendering-fluids-v1.jar': sub('fabric-rendering-fluids-v1'),
    'META-INF/jars/fabric-rendering-data-attachment-v1.jar': sub(
      'fabric-rendering-data-attachment-v1',
    ),
  })

  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'fabric-api')
  assert.equal(meta.nested.length, 2)
  assert.ok(meta.nested.some((n) => n.modId === 'fabric-rendering-fluids-v1'))
  assert.equal(
    meta.nested.find((n) => n.modId === 'fabric-rendering-fluids-v1')?.version,
    '0.4.32+1802ada577',
  )
})

test('嵌套 jar 损坏时不影响主元数据', () => {
  const buf = zipSync({
    'fabric.mod.json': strToU8(JSON.stringify({ id: 'ok-mod', version: '1.0.0' })),
    'META-INF/jars/broken.jar': strToU8('not a zip'),
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.modId, 'ok-mod')
  assert.deepEqual(meta?.nested, [])
})

test('读 Forge 的 JarJar（META-INF/jarjar/）', () => {
  const nestedToml = '[[mods]]\nmodId="mezz_config"\nversion="0.6.6"\n'
  const nested = zipSync({ 'META-INF/mods.toml': strToU8(nestedToml) })
  const buf = zipSync({
    'META-INF/mods.toml': strToU8(
      'modLoader="javafml"\n[[mods]]\nmodId="jei"\nversion="15.74.0"\n',
    ),
    'META-INF/jarjar/mezz_config-0.6.6.jar': nested,
  })

  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'jei')
  assert.equal(meta.nested.length, 1)
  assert.equal(meta.nested[0]?.modId, 'mezz_config')
  assert.equal(meta.nested[0]?.version, '0.6.6')
})

test('Fabric 与 Forge 两种嵌套路径互不干扰', () => {
  const fabricSub = zipSync({
    'fabric.mod.json': strToU8(JSON.stringify({ id: 'fab-sub', version: '1.0.0' })),
  })
  const forgeSub = zipSync({
    'META-INF/mods.toml': strToU8('[[mods]]\nmodId="forge-sub"\nversion="2.0.0"\n'),
  })
  const buf = zipSync({
    'fabric.mod.json': strToU8(JSON.stringify({ id: 'main', version: '1.0.0' })),
    'META-INF/jars/fab-sub.jar': fabricSub,
    'META-INF/jarjar/forge-sub.jar': forgeSub,
  })

  const meta = readModMetadata(buf)
  assert.equal(meta?.nested.length, 2)
  assert.ok(meta?.nested.some((n) => n.modId === 'fab-sub'))
  assert.ok(meta?.nested.some((n) => n.modId === 'forge-sub'))
})

test('description 里有裸换行也能读出元数据（Fabric 的 lenient 解析）', () => {
  // 真实样本：BetterGrassify / Debugify 的 fabric.mod.json，换行直接落在字符串里。
  // 严格 JSON.parse 会抛 Bad control character，但游戏里能正常加载。
  const raw =
    '{\n  "schemaVersion": 1,\n  "id": "debugify",\n  "version": "1.21.1+1.0",\n' +
    '  "description": "第一行\n第二行"\n}'
  const meta = readModMetadata(jar({ 'fabric.mod.json': raw }))
  assert.ok(meta, '裸换行不该让整个模组读不出来')
  assert.equal(meta.modId, 'debugify')
  assert.equal(meta.version, '1.21.1+1.0')
})

test('嵌套 jar 里的 lenient JSON 也能读到', () => {
  const inner = zipSync({
    'fabric.mod.json': strToU8('{"id":"midnightlib","version":"1.9.2","description":"a\nb"}'),
  })
  const buf = zipSync({
    'fabric.mod.json': strToU8(JSON.stringify({ id: 'puzzle', version: '2.3.0' })),
    'META-INF/jars/midnightlib-1.9.2.jar': inner,
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.nested[0]?.modId, 'midnightlib')
})

test('读 1.12.2 的 mcmod.info（数组形式）', () => {
  const buf = jar({
    'mcmod.info': JSON.stringify([
      {
        modid: 'creativecore',
        name: 'CreativeCore',
        version: '1.10.70',
        mcversion: '1.12.2',
        dependencies: ['forge', 'minecraft'],
      },
    ]),
  })
  const meta = readModMetadata(buf, { legacy: true })
  assert.ok(meta)
  assert.equal(meta.modId, 'creativecore')
  assert.equal(meta.version, '1.10.70')
  assert.equal(meta.loader, 'forge')
  assert.equal(meta.mcVersionRange, '[1.12.2]')
})

test('mcmod.info 的 { modList: [...] } 与单个对象也能读', () => {
  const list = jar({
    'mcmod.info': JSON.stringify({ modList: [{ modid: 'a', version: '1', mcversion: '1.7.10' }] }),
  })
  assert.equal(readModMetadata(list, { legacy: true })?.modId, 'a')

  const single = jar({
    'mcmod.info': JSON.stringify({ modid: 'b', version: '2', mcversion: '1.12.2' }),
  })
  assert.equal(readModMetadata(single, { legacy: true })?.modId, 'b')
})

test('老的 mcmod.info 与残留的 mods.toml 同时存在时，按实例版本选', () => {
  // RLCraft 的 SpartanShields：mods.toml 是 1.13 模板残留，写着 minecraft [1.13.2]
  const buf = jar({
    'mcmod.info': JSON.stringify([
      { modid: 'spartanshields', version: '1.5.5', mcversion: '1.12.2', dependencies: [] },
    ]),
    'META-INF/mods.toml': [
      'modLoader="javafml"',
      'loaderVersion="[25,)"',
      '[[mods]]',
      'modId="spartanshields"',
      'version="1.5.5"',
      '[[dependencies.spartanshields]]',
      'modId="minecraft"',
      'mandatory=true',
      'versionRange="[1.13.2]"',
    ].join('\n'),
  })

  const legacy = readModMetadata(buf, { legacy: true })
  assert.equal(legacy?.mcVersionRange, '[1.12.2]')

  const modern = readModMetadata(buf, { legacy: false })
  assert.equal(modern?.mcVersionRange, '[1.13.2]')
})

test('mcmod.info 的 mcversion 1.12 是前缀，不是精确 1.12', () => {
  const buf = jar({
    'mcmod.info': JSON.stringify([{ modid: 'old', version: '1', mcversion: '1.12' }]),
  })
  const meta = readModMetadata(buf, { legacy: true })
  assert.equal(meta?.mcVersionRange, '>=1.12 <1.13')
})

test('1.12.2 的 required-after: / optional: 依赖语法', () => {
  const buf = jar({
    'mcmod.info': JSON.stringify([
      {
        modid: 'enhancedvisuals',
        version: '1.4.4',
        mcversion: '1.12.2',
        dependencies: ['required-after:creativecore', 'after:minecraft', 'optional:jei'],
      },
    ]),
  })
  const meta = readModMetadata(buf, { legacy: true })
  assert.ok(meta)
  const ids = meta.dependencies.map((d) => d.modId).sort()
  // mcmod.info 的 dependencies 只是展示信息，不是硬依赖；minecraft 走 mcVersionRange
  assert.deepEqual(ids, ['creativecore'])
  assert.equal(meta.dependencies[0]?.mandatory, false)
})

test('Forge 的 [[mods]] provides 要读（Forgified Fabric API 场景）', () => {
  const buf = jar({
    'META-INF/mods.toml': [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      '[[mods]]',
      'modId="fabric_api"',
      'version="0.92.6+1.11.14+1.20.1"',
      'displayName="Forgified Fabric API"',
      'provides=["fabric", "fabric-api"]',
      '[[dependencies.fabric_api]]',
      'modId="minecraft"',
      'mandatory=true',
      'versionRange="[1.20.1,1.21)"',
    ].join('\n'),
  })
  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'fabric_api')
  assert.deepEqual([...meta.provides].sort(), ['fabric', 'fabric-api'])
  // 单个字符串也接受
  const single = jar({
    'META-INF/mods.toml': [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      '[[mods]]',
      'modId="sinytra_connector"',
      'version="2.0.0"',
      'provides="connector"',
    ].join('\n'),
  })
  assert.deepEqual(readModMetadata(single)?.provides, ['connector'])
})

test('一个 jar 声明多个 [[mods]]：其余 modId 进 provides，依赖一起收集', () => {
  const buf = jar({
    'META-INF/mods.toml': [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      '[[mods]]',
      'modId="bundle_core"',
      'version="1.0.0"',
      '[[mods]]',
      'modId="bundle_addon"',
      'version="1.0.0"',
      '[[dependencies.bundle_addon]]',
      'modId="extra_lib"',
      'mandatory=true',
      'versionRange="[1.0,)"',
    ].join('\n'),
  })
  const meta = readModMetadata(buf)
  assert.ok(meta)
  assert.equal(meta.modId, 'bundle_core')
  assert.ok(meta.provides.includes('bundle_addon'), '第二个 modId 应能被依赖匹配')
  assert.ok(
    meta.dependencies.some((d) => d.modId === 'extra_lib'),
    '多个 mod 的依赖都要收集',
  )
})

test('Forge 的 jar-in-jar 在 META-INF/jarjar/，子模块要读出来', () => {
  const sub = (id: string, version: string) =>
    zipSync({
      'META-INF/mods.toml': strToU8(
        [
          'modLoader="javafml"',
          'loaderVersion="[47,)"',
          '[[mods]]',
          `modId="${id}"`,
          `version="${version}"`,
        ].join('\n'),
      ),
    })

  const buf = zipSync({
    'META-INF/mods.toml': strToU8(
      [
        'modLoader="javafml"',
        'loaderVersion="[47,)"',
        '[[mods]]',
        'modId="fabric_api"',
        'version="0.92.6"',
        'provides=["fabric", "fabric-api"]',
      ].join('\n'),
    ),
    'META-INF/jarjar/fabric-api-base-0.4.31.jar': sub('fabric-api-base', '0.4.31'),
    'META-INF/jarjar/fabric-resource-loader-v0-0.11.11.jar': sub(
      'fabric-resource-loader-v0',
      '0.11.11',
    ),
    'META-INF/jarjar/metadata.json': strToU8('{"jars":[]}'),
  })

  const meta = readModMetadata(buf)
  assert.ok(meta)
  const ids = (meta.nested ?? []).map((n) => n.modId).sort()
  assert.deepEqual(ids, ['fabric-api-base', 'fabric-resource-loader-v0'])
})

test('NeoForge 1.20.5+ 的 type 字段：optional / incompatible 不是必需', () => {
  const buf = jar({
    'META-INF/neoforge.mods.toml': `
modLoader = "javafml"
loaderVersion = "[4,)"
[[mods]]
modId = "example"
version = "1.0.0"
displayName = "Example"
[[dependencies.example]]
modId = "minecraft"
type = "required"
versionRange = "[1.21,1.22)"
[[dependencies.example]]
modId = "jei"
type = "optional"
versionRange = "[1.0,)"
[[dependencies.example]]
modId = "bad"
type = "incompatible"
[[dependencies.example]]
modId = "legacy"
mandatory = false
`,
  })
  const meta = readModMetadata(buf)
  assert.ok(meta)
  const byId = new Map(meta.dependencies.map((d) => [d.modId, d]))
  assert.equal(byId.get('minecraft')?.mandatory, true)
  assert.equal(byId.get('jei')?.mandatory, false)
  assert.equal(byId.get('bad')?.mandatory, false)
  assert.equal(byId.get('legacy')?.mandatory, false)
})

test('显式 mandatory 优先于 type（老写法不能被新字段改写）', () => {
  const buf = jar({
    'META-INF/mods.toml': `
modLoader = "javafml"
[[mods]]
modId = "example"
version = "1.0.0"
[[dependencies.example]]
modId = "jei"
mandatory = true
type = "optional"
`,
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.dependencies.find((d) => d.modId === 'jei')?.mandatory, true)
})

test('Fabric breaks 解析为 kind=breaks，且不是 mandatory', () => {
  const buf = jar({
    'fabric.mod.json': JSON.stringify({
      schemaVersion: 1,
      id: 'a',
      version: '1.0.0',
      breaks: { b: '<1.0' },
    }),
  })
  const meta = readModMetadata(buf)
  const dep = meta?.dependencies.find((d) => d.modId === 'b')
  assert.equal(dep?.kind, 'breaks')
  assert.equal(dep?.mandatory, false)
  assert.equal(dep?.versionRange, '<1.0')
})

test('顶层没有 mods.toml、只有 jarjar 子模组时按子模组建立索引（issue #16）', () => {
  // kotlinforforge-4.12.0-all.jar 的真实形状：外层没有元数据，真 mod 在 jarjar 里
  const inner = zipSync({
    'META-INF/mods.toml': strToU8(
      ['modLoader="javafml"', '[[mods]]', 'modId="kotlinforforge"', 'version="4.12.0"'].join('\n'),
    ),
  })
  const buf = zipSync({
    'META-INF/jarjar/kffmod-4.12.0.jar': inner,
    'net/minecraftforge/fml/KotlinForForge.class': strToU8('class'),
  })

  const meta = readModMetadata(buf)
  assert.ok(meta, '只有 jar-in-jar 也要读得出身份，否则依赖方永远报缺前置')
  assert.equal(meta.modId, 'kotlinforforge')
  assert.equal(meta.version, '4.12.0')
  assert.equal(meta.loader, 'forge')
  assert.equal(meta.nestedOnly, true)
})

test('只有 JiJ 的 jar 用第一个子模组当身份，其余留在 nested', () => {
  const sub = (id: string, version: string) =>
    zipSync({
      'META-INF/mods.toml': strToU8(
        ['modLoader="javafml"', '[[mods]]', `modId="${id}"`, `version="${version}"`].join('\n'),
      ),
    })
  const buf = zipSync({
    'META-INF/jarjar/a.jar': sub('first', '1.0.0'),
    'META-INF/jarjar/b.jar': sub('second', '2.0.0'),
  })
  const meta = readModMetadata(buf)
  assert.equal(meta?.modId, 'first')
  assert.deepEqual(
    meta?.nested.map((n) => n.modId),
    ['second'],
  )
})

test('多加载器 jar 按实例加载器挑元数据（issue #17）', () => {
  // Towns-and-Towers-1.12-Fabric+Forge.jar 的形状
  const buf = jar({
    'fabric.mod.json': JSON.stringify({
      id: 'towns',
      version: '1.12',
      depends: { minecraft: '1.20.1', 'fabric-api': '*' },
    }),
    'META-INF/mods.toml': [
      'modLoader="javafml"',
      'loaderVersion="[47,)"',
      '[[mods]]',
      'modId="towns"',
      'version="1.12"',
      '[[dependencies.towns]]',
      'modId="minecraft"',
      'mandatory=true',
      'versionRange="[1.20.1,1.21)"',
    ].join('\n'),
  })

  // Forge 实例读 mods.toml：不该凭空多出 fabric-api 依赖
  const forge = readModMetadata(buf, { loader: 'forge' })
  assert.equal(forge?.loader, 'forge')
  assert.equal(
    forge?.dependencies.some((d) => d.modId === 'fabric-api'),
    false,
  )

  // Fabric 实例仍然读 fabric.mod.json
  const fabric = readModMetadata(buf, { loader: 'fabric' })
  assert.equal(fabric?.loader, 'fabric')
  assert.equal(
    fabric?.dependencies.some((d) => d.modId === 'fabric-api'),
    true,
  )
})

test('NeoForge type=incompatible 解析为 kind=breaks', () => {
  const buf = jar({
    'META-INF/neoforge.mods.toml': `
modLoader = "javafml"
[[mods]]
modId = "a"
version = "1.0.0"
[[dependencies.a]]
modId = "b"
type = "incompatible"
`,
  })
  const meta = readModMetadata(buf)
  const dep = meta?.dependencies.find((d) => d.modId === 'b')
  assert.equal(dep?.kind, 'breaks')
  assert.equal(dep?.mandatory, false)
})
