/**
 * 生成 .mrpack 夹具。
 * 用法：node scripts/make-fixture.mjs
 *
 * demo.mrpack —— 混合情况：
 *   1. 真实存在的 Modrinth 版本（Sodium 0.5.13 @ 1.20.1 fabric）
 *   2. 格式非法的版本 id（应被过滤，计为未解析）
 *   3. 本地文件（无 downloads，计为未解析）
 *
 * closure.mrpack —— 只装 Iris（它 required 依赖 Sodium），用来验证依赖闭包能
 *   跨模组反查到缺失的前置，并给出可安装的版本。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

const base = {
  formatVersion: 1,
  game: 'minecraft',
  dependencies: {
    minecraft: '1.20.1',
    'fabric-loader': '0.15.11',
  },
}

const demo = {
  ...base,
  versionId: 'blockpilot-fixture-1.0.0',
  name: 'BlockPilot Fixture Pack',
  files: [
    {
      path: 'mods/sodium-0.5.13.jar',
      hashes: { sha1: '0000000000000000000000000000000000000000', sha512: '00' },
      env: { client: 'required', server: 'unsupported' },
      downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-0.5.13.jar'],
      fileSize: 1024,
    },
    {
      path: 'mods/broken-id.jar',
      hashes: { sha1: '1111111111111111111111111111111111111111', sha512: '11' },
      downloads: ['https://cdn.modrinth.com/data/NOTAVALIDID/versions/nope/broken-id.jar'],
      fileSize: 2048,
    },
    {
      path: 'mods/local-only.jar',
      hashes: { sha1: '2222222222222222222222222222222222222222', sha512: '22' },
      downloads: [],
      fileSize: 4096,
    },
  ],
}

// Iris 1.7.6 for 1.20.1 fabric —— required 依赖 Sodium (AANobbMI)
const closure = {
  ...base,
  versionId: 'blockpilot-fixture-closure',
  name: 'BlockPilot Closure Fixture',
  files: [
    {
      path: 'mods/iris-1.7.6.jar',
      hashes: { sha1: '3333333333333333333333333333333333333333', sha512: '33' },
      env: { client: 'required', server: 'unsupported' },
      downloads: ['https://cdn.modrinth.com/data/YL57xq9U/versions/s5eFLITc/iris-1.7.6.jar'],
      fileSize: 1024,
    },
  ],
}

mkdirSync('fixtures', { recursive: true })
for (const [file, body] of [
  ['fixtures/demo.mrpack', demo],
  ['fixtures/closure.mrpack', closure],
]) {
  const zipped = zipSync({ 'modrinth.index.json': strToU8(JSON.stringify(body, null, 2)) })
  writeFileSync(file, zipped)
  console.log('wrote', file, zipped.byteLength, 'bytes')
}

