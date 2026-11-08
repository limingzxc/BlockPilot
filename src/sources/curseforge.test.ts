import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'

import {
  cfFileToVersionInfo,
  MirrorCurseforgeSource,
  resolveCurseforge,
} from './curseforge.js'
import type { CfFileInfo } from './curseforge.js'

let base = ''
let server: ReturnType<typeof createServer>
let seen: string[] = []

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.url ?? '')
    // 镜像的路径形状：/mods/{projectId}/files/{fileId}
    if (req.url === '/mods/1/files/10') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: {
            id: 10,
            modId: 1,
            fileName: 'a.jar',
            displayName: 'A',
            fileLength: 123,
            downloadUrl: 'https://edge.forgecdn.net/files/0001/010/a.jar',
            hashes: [{ algo: 1, value: 'a'.repeat(40) }],
          },
        }),
      )
      return
    }
    // 作者关了第三方下载：200 但没有 downloadUrl
    if (req.url === '/mods/3/files/12') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: { id: 12, modId: 3, fileName: 'c.jar', hashes: [{ algo: 1, value: 'c'.repeat(40) }] },
        }),
      )
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('镜像源逐个解析：404 跳过，关闭直链的保留为 null', async () => {
  seen = []
  const cf = new MirrorCurseforgeSource(base, 2)
  const map = await cf.getFiles(
    [
      { projectId: 1, fileId: 10 },
      { projectId: 2, fileId: 11 }, // 镜像没收录
      { projectId: 3, fileId: 12 },
    ],
    new AbortController().signal,
  )

  assert.equal(map.size, 2, '404 的那个不能进 map')
  assert.equal(map.get(10)?.downloadUrl, 'https://edge.forgecdn.net/files/0001/010/a.jar')
  assert.equal(map.get(10)?.hashes['sha1'], 'a'.repeat(40))
  assert.equal(map.get(12)?.downloadUrl, null, '作者关掉直链时是 null，不是缺失')
  assert.equal(map.has(11), false)
  assert.ok(seen.some((u) => u === '/mods/1/files/10'), '要用 projectId 拼路径')
})

test('镜像源对重复 fileID 只查一次', async () => {
  seen = []
  const cf = new MirrorCurseforgeSource(base, 1)
  await cf.getFiles(
    [
      { projectId: 1, fileId: 10 },
      { projectId: 1, fileId: 10 },
    ],
    new AbortController().signal,
  )
  assert.deepEqual(seen, ['/mods/1/files/10'])
})

test('resolveCurseforge：有 key 走官方，没 key 走镜像，--no-cf-mirror 时不回落', () => {
  const saved = process.env['BLOCKPILOT_CF_API_KEY']
  delete process.env['BLOCKPILOT_CF_API_KEY']
  try {
    const mirror = resolveCurseforge()
    assert.equal(mirror.label, 'MCIM · mod.mcimirror.top')
    assert.equal(mirror.configured, true)

    const official = resolveCurseforge({ apiKey: 'k' })
    assert.equal(official.label, 'api.curseforge.com')

    // 禁用回落且没有 key：回到「未配置」，deploy 会走降级安装
    const none = resolveCurseforge({ allowMirror: false })
    assert.equal(none.configured, false)
  } finally {
    if (saved !== undefined) process.env['BLOCKPILOT_CF_API_KEY'] = saved
  }
})

test('CF 的 gameVersions 拆成 MC 版本与加载器（混在一起的数组）', () => {
  const info: CfFileInfo = {
    fileId: 42,
    modId: 7,
    fileName: 'mod.jar',
    displayName: 'Some Mod',
    size: 1000,
    downloadUrl: 'https://edge.forgecdn.net/files/0000/042/mod.jar',
    hashes: { sha1: 'a'.repeat(40) },
    gameVersions: ['1.12.2', 'Forge', 'Java 8'],
    dependencies: [
      { modId: 99, relation: 'required' },
      { modId: 100, relation: 'optional' },
      { modId: 101, relation: 'incompatible' },
    ],
  }
  const v = cfFileToVersionInfo(info)
  assert.deepEqual(v.gameVersions, ['1.12.2'], 'Java 8 与 Forge 不是 MC 版本')
  assert.deepEqual(v.loaders, ['forge'])
  assert.equal(v.projectId, '7')
  assert.equal(v.versionId, '42')
  assert.equal(v.name, 'Some Mod')
  // optional 不进 dependencies（预检不判它），incompatible 要留着
  assert.deepEqual(
    v.dependencies.map((d) => [d.projectId, d.kind]),
    [
      ['99', 'required'],
      ['101', 'incompatible'],
    ],
  )
})

test('CF 文件没填 gameVersions / loaders 时给空数组，交给上层别乱判', () => {
  const v = cfFileToVersionInfo({
    fileId: 1,
    modId: 2,
    fileName: 'x.jar',
    displayName: 'X',
    size: 0,
    downloadUrl: null,
    hashes: {},
    gameVersions: [],
    dependencies: [],
  })
  assert.deepEqual(v.gameVersions, [])
  assert.deepEqual(v.loaders, [])
  assert.equal(v.files[0]?.url, '')
})
