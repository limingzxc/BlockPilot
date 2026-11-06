import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

import { resolveLayout } from '../layout.js'
import type { MrpackIndex } from '../preflight/mrpack.js'
import { buildCurseforgeTasks, buildPackTasks, extractOverrides } from './pack.js'
import type { CurseforgeManifest } from '../preflight/curseforge.js'
import type { CfFileInfo } from '../../sources/curseforge.js'

const dir = mkdtempSync(join(tmpdir(), 'bp-pack-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function index(files: MrpackIndex['files']): MrpackIndex {
  return {
    formatVersion: 1,
    game: '1.20.1',
    versionId: '1.0.0',
    name: 'test',
    files,
    dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.14' },
  }
}

const clientFile: MrpackIndex['files'][number] = {
  path: 'mods/a.jar',
  hashes: { sha1: 'a'.repeat(40) },
  env: { client: 'required', server: 'required' },
  downloads: ['https://cdn.modrinth.com/data/X/versions/Y/a.jar'],
  fileSize: 100,
}

test('客户端需要的文件进入任务列表', () => {
  const tasks = buildPackTasks(index([clientFile]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.fileName, 'a.jar')
})

test('服务端专用文件被排除', () => {
  const serverOnly = {
    ...clientFile,
    path: 'mods/server.jar',
    env: { client: 'unsupported' as const, server: 'required' as const },
  }
  const tasks = buildPackTasks(index([clientFile, serverOnly]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1, '只装客户端需要的')
})

test('没有 env 的文件默认装上', () => {
  const noEnv = { ...clientFile, path: 'mods/b.jar', env: undefined }
  const tasks = buildPackTasks(index([noEnv]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1)
})

test('落地路径相对于实例根', () => {
  const tasks = buildPackTasks(index([clientFile]), resolveLayout(dir, 'inst'))
  assert.ok(tasks[0]?.destPath.endsWith(join('instances', 'inst', 'mods', 'a.jar')))
})

test('没有 downloads 的文件被跳过', () => {
  const broken = { ...clientFile, downloads: [] }
  const tasks = buildPackTasks(index([broken]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 0)
})

test('overrides 与 client-overrides 都解压，后者覆盖前者', () => {
  const packPath = join(dir, 'p.mrpack')
  writeFileSync(
    packPath,
    zipSync({
      'modrinth.index.json': strToU8('{}'),
      'overrides/config.toml': strToU8('from-overrides'),
      'client-overrides/config.toml': strToU8('from-client-overrides'),
      'overrides/only.toml': strToU8('only'),
      'mods/should-not-extract.jar': strToU8('x'),
    }),
  )
  const gameDir = join(dir, 'game')
  const count = extractOverrides(packPath, gameDir)

  // count 是写入次数：config.toml 被写两次（overrides 一次、client-overrides 覆盖一次）
  assert.equal(count, 3)
  assert.equal(readFileSync(join(gameDir, 'config.toml'), 'utf8'), 'from-client-overrides')
  assert.equal(readFileSync(join(gameDir, 'only.toml'), 'utf8'), 'only')
})

// ---------------- CurseForge ----------------

function cfManifest(files: CurseforgeManifest['files']): CurseforgeManifest {
  return {
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: 'cf-test',
    minecraft: { version: '1.12.2', modLoaders: [{ id: 'forge-14.23.5.2860', primary: true }] },
    files,
    overrides: 'overrides',
  }
}

function cfInfo(partial: Partial<CfFileInfo> & Pick<CfFileInfo, 'fileId' | 'fileName'>): CfFileInfo {
  return {
    modId: 1,
    displayName: partial.fileName,
    size: 1024,
    downloadUrl: 'https://mediafilez.forgecdn.net/files/1/2/a.jar',
    hashes: { sha1: 'b'.repeat(40) },
    gameVersions: ['1.12.2', 'Forge'],
    dependencies: [],
    ...partial,
  }
}

test('CF 包：fileID 换成下载任务，落到 mods/ 下', () => {
  const layout = resolveLayout(join(dir, 'cf'), 'inst')
  const manifest = cfManifest([{ projectID: 1, fileID: 100, required: true }])
  const files = new Map([[100, cfInfo({ fileId: 100, fileName: 'a.jar' })]])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(unresolved.length, 0)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.fileName, 'a.jar')
  assert.equal(tasks[0]?.destPath, join(layout.mods, 'a.jar'))
  assert.equal(tasks[0]?.hashes['sha1'], 'b'.repeat(40))
})

test('CF 包：作者关了第三方下载 → unresolved，不静默丢弃', () => {
  const layout = resolveLayout(join(dir, 'cf2'), 'inst')
  const manifest = cfManifest([{ projectID: 1, fileID: 100, required: true }])
  const files = new Map([[100, cfInfo({ fileId: 100, fileName: 'blocked.jar', downloadUrl: null })]])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(tasks.length, 0)
  assert.equal(unresolved.length, 1)
  assert.match(unresolved[0]?.error ?? '', /关闭了第三方下载/)
})

test('CF 包：API 没返回的 fileID 也报出来，required=false 跳过', () => {
  const layout = resolveLayout(join(dir, 'cf3'), 'inst')
  const manifest = cfManifest([
    { projectID: 1, fileID: 100, required: true },
    { projectID: 2, fileID: 200, required: false },
  ])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, new Map(), layout)
  assert.equal(tasks.length, 0)
  assert.equal(unresolved.length, 1)
  assert.match(unresolved[0]?.fileName ?? '', /project-1-file-100/)
})

test('CF 包：同名文件不互相覆盖', () => {
  const layout = resolveLayout(join(dir, 'cf4'), 'inst')
  const manifest = cfManifest([
    { projectID: 1, fileID: 100, required: true },
    { projectID: 2, fileID: 200, required: true },
  ])
  const files = new Map([
    [100, cfInfo({ fileId: 100, fileName: 'same.jar' })],
    [200, cfInfo({ fileId: 200, fileName: 'Same.jar' })],
  ])
  const { tasks } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(tasks.length, 2)
  assert.notEqual(tasks[0]?.destPath, tasks[1]?.destPath)
})
