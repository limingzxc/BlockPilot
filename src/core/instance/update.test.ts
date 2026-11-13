import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DependencyResolver, VersionInfo } from '../content-source.js'
import { collect } from '../events/operation.js'
import { buildLock, readLock, writeLock } from './lock.js'
import { checkUpdates } from './update.js'

const LOADER = { kind: 'fabric' as const, version: '0.16.14' }

function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-update-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function version(projectId: string, versionId: string): VersionInfo {
  return {
    projectId,
    versionId,
    name: `Project ${projectId}`,
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [
      {
        url: `https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/new.jar`,
        filename: 'new.jar',
        size: 10,
        primary: true,
        hashes: { sha1: 'a'.repeat(40) },
      },
    ],
  }
}

test('可更新 / 已最新 / 非 Modrinth 分别归类', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'mrpack',
        packFile: 'p.mrpack',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          { path: 'mods/old.jar', projectId: 'old', versionId: 'v1', source: 'modrinth', size: 1 },
          {
            path: 'mods/current.jar',
            projectId: 'cur',
            versionId: 'v2',
            source: 'modrinth',
            size: 1,
          },
          {
            path: 'mods/cf.jar',
            projectId: '123',
            versionId: '456',
            source: 'curseforge',
            size: 1,
          },
          { path: 'mods/manual.jar', size: 1 },
        ],
      }),
    )

    const resolver: DependencyResolver = {
      resolve: async (projectId) => {
        if (projectId === 'old') return version('old', 'v9')
        if (projectId === 'cur') return version('cur', 'v2')
        return null
      },
    }

    const r = await collect(checkUpdates({ gameDir: dir, resolver }))
    assert.equal(r.checked, 3)
    assert.equal(r.upToDate, 1)
    assert.equal(r.skipped, 1)
    assert.equal(r.updates.length, 1)
    assert.equal(r.updates[0]?.path, 'mods/old.jar')
    assert.equal(r.updates[0]?.from, 'v1')
    assert.equal(r.updates[0]?.to, 'v9')
    assert.equal(r.updates[0]?.fileName, 'new.jar')
  })
})

test('内容源没有兼容版本：进 failed，不算更新', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'mrpack',
        packFile: 'p.mrpack',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          { path: 'mods/x.jar', projectId: 'x', versionId: 'v1', source: 'modrinth', size: 1 },
        ],
      }),
    )
    const r = await collect(checkUpdates({ gameDir: dir, resolver: { resolve: async () => null } }))
    assert.equal(r.updates.length, 0)
    assert.equal(r.failed.length, 1)
    assert.match(r.failed[0]?.error ?? '', /没有兼容/)
  })
})

test('没有 lock：LOCK_NOT_FOUND', async () => {
  await withTemp(async (dir) => {
    await assert.rejects(
      () => collect(checkUpdates({ gameDir: dir, resolver: { resolve: async () => null } })),
      (err: Error & { code?: string }) => err.code === 'LOCK_NOT_FOUND',
    )
  })
})

test('--apply：下载校验后替换旧文件并重写 lock', async () => {
  const { createServer } = await import('node:http')
  const { createHash } = await import('node:crypto')
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
  const body = Buffer.from('new jar bytes')
  const sha1 = createHash('sha1').update(body).digest('hex')
  const server = createServer((req, res) => {
    if (req.url === '/new.jar') {
      res.writeHead(200, { 'content-length': body.length })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  await withTemp(async (dir) => {
    mkdirSync(join(dir, 'mods'), { recursive: true })
    writeFileSync(join(dir, 'mods', 'old.jar'), 'old')
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'mrpack',
        packFile: 'p.mrpack',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          { path: 'mods/old.jar', projectId: 'p', versionId: 'v1', source: 'modrinth', size: 3 },
        ],
      }),
    )

    const resolver: DependencyResolver = {
      resolve: async () => ({
        projectId: 'p',
        versionId: 'v9',
        name: 'P',
        gameVersions: ['1.20.1'],
        loaders: ['fabric'],
        dependencies: [],
        files: [
          {
            url: `http://127.0.0.1:${port}/new.jar`,
            filename: 'new.jar',
            size: body.length,
            primary: true,
            hashes: { sha1 },
          },
        ],
      }),
    }
    const direct = { name: 'test', credit: '', rewrite: (u: URL) => u.toString() }

    const r = await collect(
      checkUpdates({ gameDir: dir, resolver, apply: true, sources: [direct] }),
    )
    assert.equal(r.applied.length, 1)
    assert.equal(r.applyFailed.length, 0)
    assert.equal(existsSync(join(dir, 'mods', 'old.jar')), false)
    assert.equal(readFileSync(join(dir, 'mods', 'new.jar'), 'utf8'), body.toString())

    const lock = readLock(dir)
    assert.equal(lock?.files[0]?.path, 'mods/new.jar')
    assert.equal(lock?.files[0]?.versionId, 'v9')
    assert.equal(lock?.files[0]?.source, 'modrinth')
  })

  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('CurseForge 条目用 getLatestFile 反查，比较 fileId', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'curseforge',
        packFile: 'p.zip',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          {
            path: 'mods/cf.jar',
            projectId: '238222',
            versionId: '1',
            source: 'curseforge',
            size: 1,
          },
        ],
      }),
    )

    const r = await collect(
      checkUpdates({
        gameDir: dir,
        resolver: { resolve: async () => null },
        cfResolver: {
          configured: true,
          label: 'fake',
          getFiles: async () => new Map(),
          getLatestFile: async () => ({
            fileId: 2,
            modId: 238222,
            fileName: 'cf-2.jar',
            displayName: 'CF 2',
            size: 5,
            downloadUrl: 'https://edge.forgecdn.net/files/2/cf-2.jar',
            hashes: { sha1: 'a'.repeat(40) },
            gameVersions: ['1.20.1', 'Fabric'],
            dependencies: [],
          }),
        },
      }),
    )

    assert.equal(r.checked, 1)
    assert.equal(r.updates.length, 1)
    assert.equal(r.updates[0]?.source, 'curseforge')
    assert.equal(r.updates[0]?.from, '1')
    assert.equal(r.updates[0]?.to, '2')
    assert.equal(r.updates[0]?.fileName, 'cf-2.jar')
  })
})

test('Modrinth：最新 release 比已装 beta 更旧时不提供降级', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'mrpack',
        packFile: 'p.mrpack',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          {
            path: 'mods/x.jar',
            projectId: 'xxxxxxx1',
            versionId: 'beta',
            source: 'modrinth',
            size: 1,
          },
        ],
      }),
    )
    const latest: VersionInfo = {
      ...version('xxxxxxx1', 'release'),
      datePublished: '2026-01-01T00:00:00Z',
    }
    const current: VersionInfo = {
      ...version('xxxxxxx1', 'beta'),
      datePublished: '2026-02-01T00:00:00Z',
    }
    const r = await collect(
      checkUpdates({
        gameDir: dir,
        resolver: { resolve: async () => latest },
        versionSource: { name: 'stub', getVersions: async () => [current] },
      }),
    )
    assert.equal(r.updates.length, 0, '旧 release 不该盖掉新 beta')
    assert.equal(r.upToDate, 1)
  })
})

test('CurseForge：最新 fileId 比已装的小时不提供降级', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'curseforge',
        packFile: 'p.zip',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          { path: 'mods/cf.jar', projectId: '1', versionId: '200', source: 'curseforge', size: 1 },
        ],
      }),
    )
    const r = await collect(
      checkUpdates({
        gameDir: dir,
        resolver: { resolve: async () => null },
        cfResolver: {
          configured: true,
          label: 'fake',
          getFiles: async () => new Map(),
          getLatestFile: async () => ({
            fileId: 100,
            modId: 1,
            fileName: 'cf-100.jar',
            displayName: 'CF 100',
            size: 5,
            downloadUrl: 'https://edge.forgecdn.net/files/100/cf-100.jar',
            hashes: { sha1: 'a'.repeat(40) },
            gameVersions: ['1.20.1', 'Fabric'],
            dependencies: [],
          }),
        },
      }),
    )
    assert.equal(r.updates.length, 0)
    assert.equal(r.upToDate, 1)
  })
})

test('CurseForge 条目没有解析器：进 failed，不影响其它条目', async () => {
  await withTemp(async (dir) => {
    writeLock(
      dir,
      buildLock({
        packName: 't',
        packKind: 'curseforge',
        packFile: 'p.zip',
        gameVersion: '1.20.1',
        loader: LOADER,
        complete: true,
        files: [
          { path: 'mods/cf.jar', projectId: '1', versionId: '1', source: 'curseforge', size: 1 },
        ],
      }),
    )
    const r = await collect(checkUpdates({ gameDir: dir, resolver: { resolve: async () => null } }))
    assert.equal(r.failed.length, 1)
    assert.match(r.failed[0]?.error ?? '', /CurseForge/)
  })
})
