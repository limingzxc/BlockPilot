import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'

import {
  curseforgeToInstance,
  isCurseforgeZip,
  parseLoaderId,
  readCurseforgePack,
} from './curseforge.js'

/**
 * manifest 样例抄自 GDLauncher 的格式文档与真实包：
 * https://gdlauncher.com/docs/modpack-manifest-format
 */
const SAMPLE = {
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  name: 'Example Pack',
  version: '1.0.0',
  author: 'someone',
  minecraft: {
    version: '1.20.1',
    modLoaders: [{ id: 'forge-47.2.0', primary: true }],
  },
  files: [
    { projectID: 238222, fileID: 5246076, required: true },
    { projectID: 306612, fileID: 5010374, required: true },
    { projectID: 999999, fileID: 1234567, required: false },
  ],
  overrides: 'overrides',
}

function withZip(files: Record<string, string>, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-cf-'))
  const p = join(dir, 'pack.zip')
  writeFileSync(
    p,
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))),
  )
  try {
    fn(p)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('解析 manifest：MC 版本、加载器、必需文件数', () => {
  withZip({ 'manifest.json': JSON.stringify(SAMPLE), 'overrides/config.toml': 'x' }, (p) => {
    const pack = readCurseforgePack(p)
    assert.equal(pack.instance.name, 'Example Pack')
    assert.equal(pack.instance.gameVersion, '1.20.1')
    assert.deepEqual(pack.instance.loader, { kind: 'forge', version: '47.2.0' })
    // required: false 的文件不算必需
    assert.equal(pack.requiredCount, 2)
    assert.equal(pack.instance.mods.length, 2)
  })
})

test('isCurseforgeZip 只认 manifestType，普通 zip 不冒充', () => {
  withZip({ 'manifest.json': JSON.stringify(SAMPLE) }, (p) => {
    assert.equal(isCurseforgeZip(p), true)
  })
  withZip({ 'readme.txt': 'hello' }, (p) => {
    assert.equal(isCurseforgeZip(p), false)
  })
  withZip({ 'manifest.json': '{"manifestType":"something-else"}' }, (p) => {
    assert.equal(isCurseforgeZip(p), false)
  })
})

test('loader id 的大小写与格式变体（真实包里都出现过）', () => {
  assert.deepEqual(parseLoaderId('forge-47.2.0'), { kind: 'forge', version: '47.2.0' })
  assert.deepEqual(parseLoaderId('fabric-0.15.3'), { kind: 'fabric', version: '0.15.3' })
  // BianLianYaoGuai 导出工具的示例：NeoForge 大写开头
  assert.deepEqual(parseLoaderId('NeoForge-47.1.106'), { kind: 'neoforge', version: '47.1.106' })
  assert.deepEqual(parseLoaderId('neoforge-20.4.237'), { kind: 'neoforge', version: '20.4.237' })
  // 认不出的 kind 不硬套，version 保留
  assert.deepEqual(parseLoaderId('rift-1.13'), { kind: 'vanilla', version: '1.13' })
})

test('没有 modLoaders 时按 vanilla 处理', () => {
  const m = { ...SAMPLE, minecraft: { version: '1.21.1', modLoaders: [] } }
  const inst = curseforgeToInstance(m)
  assert.equal(inst.loader.kind, 'vanilla')
  assert.equal(inst.gameVersion, '1.21.1')
})

test('没有 primary 时取第一个 loader', () => {
  const m = {
    ...SAMPLE,
    minecraft: {
      version: '1.20.1',
      modLoaders: [{ id: 'fabric-0.15.11', primary: false }, { id: 'forge-47.2.0' }],
    },
  }
  const inst = curseforgeToInstance(m)
  assert.deepEqual(inst.loader, { kind: 'fabric', version: '0.15.11' })
})

test('zip 里没有 manifest.json 时给出明确的错', () => {
  withZip({ 'whatever.txt': 'x' }, (p) => {
    assert.throws(() => readCurseforgePack(p), /manifest\.json/)
  })
})

test('readPackFile：一个入口同时认 mrpack 与 CF，并声明能力', async () => {
  const { readPackFile } = await import('./read-pack.js')
  const dir = mkdtempSync(join(tmpdir(), 'bp-readpack-'))
  try {
    const cfPath = join(dir, 'cf.zip')
    writeFileSync(cfPath, zipSync({ 'manifest.json': strToU8(JSON.stringify(SAMPLE)) }))
    const cf = readPackFile(cfPath)
    assert.equal(cf.kind, 'curseforge')
    assert.equal(cf.ability.givesDownloadUrls, false)
    assert.equal(cf.ability.checksMods, false)
    assert.equal(cf.instance.gameVersion, '1.20.1')
    assert.equal('mrpackIndex' in cf, false)

    const mrPath = join(dir, 'pack.mrpack')
    writeFileSync(
      mrPath,
      zipSync({
        'modrinth.index.json': strToU8(
          JSON.stringify({
            formatVersion: 1,
            game: 'minecraft',
            versionId: '1.0.0',
            name: 'P',
            files: [],
            dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.14' },
          }),
        ),
      }),
    )
    const mr = readPackFile(mrPath)
    assert.equal(mr.kind, 'mrpack')
    assert.equal(mr.ability.givesDownloadUrls, true)
    assert.ok(mr.mrpackIndex !== undefined)

    // 两种都不是 → 抛错，由调用方转成 BAD_MODPACK
    const bogus = join(dir, 'x.zip')
    writeFileSync(bogus, zipSync({ 'readme.txt': strToU8('hi') }))
    assert.throws(() => readPackFile(bogus), /无法解析整合包/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
