import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import type { CfFileInfo } from '../../sources/curseforge.js'
import { resolveLayout } from '../layout.js'
import type { CurseforgeManifest } from '../pack/curseforge.js'
import type { MrpackIndex } from '../pack/mrpack.js'
import { buildCurseforgeTasks, buildPackTasks, extractOverrides } from './pack.js'

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

function packTasks(
  i: MrpackIndex,
  layout: ReturnType<typeof resolveLayout>,
  opts?: Parameters<typeof buildPackTasks>[2],
) {
  return buildPackTasks(i, layout, opts).tasks
}

test('客户端需要的文件进入任务列表', () => {
  const tasks = packTasks(index([clientFile]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.fileName, 'a.jar')
})

test('服务端专用文件被排除', () => {
  const serverOnly = {
    ...clientFile,
    path: 'mods/server.jar',
    env: { client: 'unsupported' as const, server: 'required' as const },
  }
  const tasks = packTasks(index([clientFile, serverOnly]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1, '只装客户端需要的')
})

test('没有 env 的文件默认装上', () => {
  const { env: _env, ...withoutEnv } = clientFile
  const noEnv = { ...withoutEnv, path: 'mods/b.jar' }
  const tasks = packTasks(index([noEnv]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 1)
})

test('落地路径相对于实例根', () => {
  const tasks = packTasks(index([clientFile]), resolveLayout(dir, 'inst'))
  assert.ok(tasks[0]?.destPath.endsWith(join('instances', 'inst', 'mods', 'a.jar')))
})

test('没有 downloads 的文件被跳过', () => {
  const broken = { ...clientFile, downloads: [] }
  const tasks = packTasks(index([broken]), resolveLayout(dir, 't'))
  assert.equal(tasks.length, 0)
})

test('清单里的下载域名必须在白名单内（挡住内网地址）', () => {
  const evil = {
    ...clientFile,
    path: 'mods/evil.jar',
    downloads: ['http://169.254.169.254/latest/meta-data/x.jar'],
  }
  const built = buildPackTasks(index([evil]), resolveLayout(dir, 'wl'))
  assert.equal(built.tasks.length, 0)
  assert.equal(built.rejected.length, 1)
  assert.match(built.rejected[0]?.error ?? '', /白名单/)
})

test('--allow-host 可以显式放行本地服务', () => {
  const local = {
    ...clientFile,
    path: 'mods/local.jar',
    downloads: ['http://127.0.0.1:8080/a.jar'],
  }
  const built = buildPackTasks(index([local]), resolveLayout(dir, 'wl2'), {
    allowHosts: ['127.0.0.1'],
  })
  assert.equal(built.tasks.length, 1)
  assert.equal(built.rejected.length, 0)
})

test('清单里没有下载地址的条目进 rejected，不静默少装', () => {
  const noUrl = { ...clientFile, path: 'mods/nodl.jar', downloads: [] }
  const built = buildPackTasks(index([noUrl]), resolveLayout(dir, 'wl4'))
  assert.equal(built.tasks.length, 0)
  assert.equal(built.rejected.length, 1)
  assert.match(built.rejected[0]?.error ?? '', /没有下载地址/)
})

test('清单路径穿越被拒绝，并作为失败项报出来', () => {
  const evil = { ...clientFile, path: '../../evil.jar' }
  const built = buildPackTasks(index([evil]), resolveLayout(dir, 'wl3'))
  assert.equal(built.tasks.length, 0)
  assert.match(built.rejected[0]?.error ?? '', /路径不安全/)
})

test('overrides 默认不覆盖已存在的文件，--overwrite 才覆盖', async () => {
  const packPath = join(dir, 'keep.mrpack')
  writeFileSync(
    packPath,
    zipSync({
      'modrinth.index.json': strToU8('{}'),
      'overrides/config.toml': strToU8('from-pack'),
    }),
  )
  const gameDir = join(dir, 'keep-game')
  mkdirSync(gameDir, { recursive: true })
  writeFileSync(join(gameDir, 'config.toml'), 'user-edited')

  const first = await extractOverrides(packPath, gameDir)
  assert.equal(first.skipped, 1)
  assert.equal(first.files, 0)
  assert.equal(readFileSync(join(gameDir, 'config.toml'), 'utf8'), 'user-edited')

  const forced = await extractOverrides(packPath, gameDir, { overwrite: true })
  assert.equal(forced.files, 1)
  assert.equal(readFileSync(join(gameDir, 'config.toml'), 'utf8'), 'from-pack')
})

test('overrides 与 client-overrides 都解压，后者覆盖前者', async () => {
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
  const count = await extractOverrides(packPath, gameDir)

  // files 是写入次数：config.toml 被写两次（overrides 一次、client-overrides 覆盖一次）
  assert.equal(count.files, 3)
  assert.equal(count.mods, 0)
  assert.equal(readFileSync(join(gameDir, 'config.toml'), 'utf8'), 'from-client-overrides')
  assert.equal(readFileSync(join(gameDir, 'only.toml'), 'utf8'), 'only')
})

test('大文件跨多个读取块仍能完整流式落盘', async () => {
  const payload = new Uint8Array(randomBytes(300_000))
  const packPath = join(dir, 'p-big.mrpack')
  writeFileSync(packPath, zipSync({ 'overrides/big.bin': payload }))
  const gameDir = join(dir, 'game-big')
  const result = await extractOverrides(packPath, gameDir)
  assert.equal(result.files, 1)
  assert.deepEqual(readFileSync(join(gameDir, 'big.bin')), Buffer.from(payload))
})

test('zip 里 client-overrides 排在前面时，仍然赢过 overrides', async () => {
  const packPath = join(dir, 'p-reversed.mrpack')
  writeFileSync(
    packPath,
    zipSync({
      'client-overrides/config.toml': strToU8('from-client-overrides'),
      'overrides/config.toml': strToU8('from-overrides'),
    }),
  )
  const gameDir = join(dir, 'game-reversed')
  const count = await extractOverrides(packPath, gameDir)
  assert.equal(readFileSync(join(gameDir, 'config.toml'), 'utf8'), 'from-client-overrides')
  assert.equal(count.skipped, 1, '后到的 overrides 不该盖掉 client-overrides')
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

function cfInfo(
  partial: Partial<CfFileInfo> & Pick<CfFileInfo, 'fileId' | 'fileName'>,
): CfFileInfo {
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
  const files = new Map([
    [100, cfInfo({ fileId: 100, fileName: 'blocked.jar', downloadUrl: null })],
  ])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(tasks.length, 0)
  assert.equal(unresolved.length, 1)
  assert.match(unresolved[0]?.error ?? '', /关闭了第三方下载/)
})

test('CF 包：下载地址不在 forgecdn 域 → unresolved，不向任意地址发请求', () => {
  const layout = resolveLayout(join(dir, 'cf-host'), 'inst')
  const manifest = cfManifest([{ projectID: 1, fileID: 100, required: true }])
  const files = new Map([
    [
      100,
      cfInfo({
        fileId: 100,
        fileName: 'a.jar',
        downloadUrl: 'https://evil.example.com/a.jar',
      }),
    ],
  ])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(tasks.length, 0)
  assert.equal(unresolved.length, 1)
  assert.match(unresolved[0]?.error ?? '', /Forge CDN/)
})

test('CF 包：接口返回的文件名只取 basename，不能写出 mods/', () => {
  const layout = resolveLayout(join(dir, 'cf-name'), 'inst')
  const manifest = cfManifest([{ projectID: 1, fileID: 100, required: true }])
  const files = new Map([[100, cfInfo({ fileId: 100, fileName: '../../evil.jar' })]])
  const { tasks, unresolved } = buildCurseforgeTasks(manifest, files, layout)
  assert.equal(unresolved.length, 0)
  assert.equal(tasks[0]?.fileName, 'evil.jar')
  assert.equal(tasks[0]?.destPath, join(layout.mods, 'evil.jar'))
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

test('overrides 解压只收 overrides 与 client-overrides（issue #13）', async () => {
  const zipPath = join(dir, 'overrides-count.zip')
  writeFileSync(
    zipPath,
    zipSync({
      'manifest.json': strToU8('{}'),
      'overrides/mods/aaa.jar': strToU8('x'),
      'overrides/mods/bbb.JAR': strToU8('x'),
      'overrides/mods/readme.txt': strToU8('x'),
      'overrides/config/x.toml': strToU8('x'),
      'client-overrides/mods/ccc.jar': strToU8('x'),
      'other/mods/ignored.jar': strToU8('x'),
    }),
  )

  const layout = resolveLayout(join(dir, 'game-overrides'), 'default')
  const extracted = await extractOverrides(zipPath, layout.gameDir)
  assert.equal(extracted.mods, 3)
  // overrides + client-overrides 一共 5 个文件（manifest 与 other/ 不算）
  assert.equal(extracted.files, 5)
})

test('没有 key 时 buildCurseforgeTasks 的失败原因直指配置，不是「可能已下架」', () => {
  const manifest: CurseforgeManifest = {
    manifestType: 'minecraftModpack',
    minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.22', primary: true }] },
    files: [{ projectID: 238222, fileID: 5246076, required: true }],
  }
  const layout = resolveLayout(join(dir, 'game-nokey'), 'default')
  const built = buildCurseforgeTasks(manifest, new Map(), layout, { noKey: true })
  assert.equal(built.tasks.length, 0)
  assert.equal(built.unresolved.length, 1)
  assert.match(built.unresolved[0]?.error ?? '', /BLOCKPILOT_CF_API_KEY/)
  assert.doesNotMatch(built.unresolved[0]?.error ?? '', /可能已下架/)
})
