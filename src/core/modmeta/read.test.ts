import assert from 'node:assert/strict'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

import { NON_MOD_DEPENDENCY_IDS } from './types.js'
import { readModMetadata } from './read.js'

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
