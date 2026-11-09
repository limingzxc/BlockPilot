import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Op } from '../events.js'
import { collect, defineOperation } from '../operation.js'
import type { LoaderSetupOutcome } from './loader-update.js'
import { updateLoader } from './loader-update.js'
import { buildLock, readLock, writeLock } from './lock.js'

const LOADER = { kind: 'fabric' as const, version: '0.16.14' }

function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-loader-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function lock(dir: string): void {
  writeLock(
    dir,
    buildLock({
      packName: 't',
      packKind: 'mrpack',
      packFile: 'p.mrpack',
      gameVersion: '1.20.1',
      loader: LOADER,
      complete: true,
      files: [],
    }),
  )
}

function setup(value: LoaderSetupOutcome) {
  return defineOperation<LoaderSetupOutcome>('fake-setup', async function* () {
    yield Op.log('info', 'fabric.loader', {
      gameVersion: '1.20.1',
      loaderVersion: value.loaderVersion,
      flavor: 'official',
    })
    yield Op.result(value)
    yield Op.done()
  })
}

test('升级成功后写回 lock 的 loader.version', async () => {
  await withTemp(async (dir) => {
    lock(dir)
    const r = await collect(
      updateLoader({
        gameDir: dir,
        setup: setup({
          versionId: 'fabric-loader-0.16.15-1.20.1',
          loaderVersion: '0.16.15',
          versionJsonPath: join(dir, 'versions', 'x.json'),
        }),
      }),
    )
    assert.equal(r.from, '0.16.14')
    assert.equal(r.to, '0.16.15')
    assert.equal(readLock(dir)?.target.loader.version, '0.16.15')
  })
})

test('setup 失败：原样转发，lock 不动', async () => {
  await withTemp(async (dir) => {
    lock(dir)
    const failing = defineOperation<LoaderSetupOutcome>('bad-setup', async function* () {
      yield Op.failed('NO_FABRIC_FOR_VERSION', '没有 loader')
    })
    await assert.rejects(
      () => collect(updateLoader({ gameDir: dir, setup: failing })),
      (err: Error & { code?: string }) => err.code === 'NO_FABRIC_FOR_VERSION',
    )
    assert.equal(readLock(dir)?.target.loader.version, '0.16.14')
  })
})

test('没有 lock：LOCK_NOT_FOUND', async () => {
  await withTemp(async (dir) => {
    await assert.rejects(
      () =>
        collect(
          updateLoader({
            gameDir: dir,
            setup: setup({ versionId: 'v', loaderVersion: '1' }),
          }),
        ),
      (err: Error & { code?: string }) => err.code === 'LOCK_NOT_FOUND',
    )
  })
})
