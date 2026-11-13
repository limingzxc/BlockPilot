import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import type { DownloadTask } from '../download/types.js'
import { collect } from '../events/operation.js'
import type { LockedFile, LockFile } from './lock.js'
import { buildLock, createVerify, lockPath, readLock, toLockedFile, writeLock } from './lock.js'

const LOADER = { kind: 'fabric' as const, version: '0.16.14' }

function withTemp(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-lock-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function lock(files: readonly LockedFile[], complete = true): LockFile {
  return buildLock({
    packName: 'test',
    packKind: 'mrpack',
    packFile: 'pack.mrpack',
    gameVersion: '1.20.1',
    loader: LOADER,
    complete,
    files,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  })
}

test('写入后能原样读回，updatedAt 来自注入时钟', async () => {
  await withTemp((dir) => {
    const l = lock([{ path: 'mods/a.jar', sha1: 'a'.repeat(40), size: 3 }])
    const path = writeLock(dir, l)
    assert.equal(path, lockPath(dir))
    const back = readLock(dir)
    assert.deepEqual(back, l)
    assert.equal(back?.updatedAt, '2026-01-02T03:04:05.000Z')
  })
})

test('toLockedFile 用相对实例根的 posix 路径', () => {
  const base = join(tmpdir(), 'bp-lock-relative', 'instances', 'x')
  const task: DownloadTask = {
    url: 'https://cdn.modrinth.com/data/X/versions/Y/a.jar',
    fileName: 'a.jar',
    destPath: join(base, 'mods', 'a.jar'),
    expectedSize: 10,
    hashes: { sha1: 'b'.repeat(40), sha512: 'c'.repeat(128) },
  }
  const f = toLockedFile(task, base)
  assert.equal(f.path, 'mods/a.jar')
  assert.equal(f.sha1, 'b'.repeat(40))
  assert.equal(f.sha512, 'c'.repeat(128))
})

test('全部文件与哈希一致：okAll', async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, 'mods'), { recursive: true })
    writeFileSync(join(dir, 'mods', 'a.jar'), 'hello')
    writeLock(dir, lock([{ path: 'mods/a.jar', sha1: sha1('hello'), size: 5 }]))

    const r = await collect(createVerify({ gameDir: dir }))
    assert.equal(r.checked, 1)
    assert.equal(r.ok, 1)
    assert.deepEqual(r.issues, [])
    assert.equal(r.okAll, true)
  })
})

test('缺文件与哈希不符分别归类', async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, 'mods'), { recursive: true })
    writeFileSync(join(dir, 'mods', 'bad.jar'), 'tampered')
    writeLock(
      dir,
      lock([
        { path: 'mods/missing.jar', sha1: sha1('x'), size: 1 },
        { path: 'mods/bad.jar', sha1: sha1('hello'), size: 5 },
      ]),
    )

    const r = await collect(createVerify({ gameDir: dir }))
    assert.deepEqual(r.issues.map((i) => `${i.path}:${i.reason}`).sort(), [
      'mods/bad.jar:mismatch',
      'mods/missing.jar:missing',
    ])
    assert.equal(r.okAll, false)
  })
})

test('上次部署未完成：文件都在也不算 ok', async () => {
  await withTemp(async (dir) => {
    mkdirSync(join(dir, 'mods'), { recursive: true })
    writeFileSync(join(dir, 'mods', 'a.jar'), 'hello')
    writeLock(dir, lock([{ path: 'mods/a.jar', sha1: sha1('hello'), size: 5 }], false))

    const r = await collect(createVerify({ gameDir: dir }))
    assert.deepEqual(r.issues, [])
    assert.equal(r.okAll, false)
  })
})

test('没有 lock：报 LOCK_NOT_FOUND', async () => {
  await withTemp(async (dir) => {
    await assert.rejects(
      () => collect(createVerify({ gameDir: dir })),
      (err: Error & { code?: string }) => err.code === 'LOCK_NOT_FOUND',
    )
  })
})

test('lock 损坏：报 LOCK_CORRUPT，不当成「没有清单」', async () => {
  await withTemp(async (dir) => {
    mkdirSync(dirname(lockPath(dir)), { recursive: true })
    writeFileSync(lockPath(dir), '{ not json')
    await assert.rejects(
      () => collect(createVerify({ gameDir: dir })),
      (err: Error & { code?: string }) => err.code === 'LOCK_CORRUPT',
    )
  })
})
