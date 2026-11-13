import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import type { VersionInfo } from '../content-source.js'
import type { downloadOne } from '../download/downloader.js'
import type { DownloadTask } from '../download/types.js'
import { BlockPilotError } from '../errors.js'
import { resolveLayout } from '../layout.js'
import type { LatestVersionSource } from './pack-source.js'
import { resolvePackTarget } from './pack-source.js'

const dir = mkdtempSync(join(tmpdir(), 'bp-pack-source-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function version(over: Partial<VersionInfo> = {}): VersionInfo {
  return {
    projectId: 'pack',
    versionId: 'pv1',
    name: 'Demo Pack',
    gameVersions: ['1.20.1'],
    loaders: ['fabric'],
    dependencies: [],
    files: [
      {
        url: 'https://cdn.modrinth.com/data/pack/versions/pv1/demo.mrpack',
        filename: 'demo.mrpack',
        size: 10,
        primary: true,
        hashes: { sha1: '00' },
      },
    ],
    ...over,
  }
}

function sourceOf(result: VersionInfo | null | Error): LatestVersionSource {
  return {
    async getLatestVersion() {
      if (result instanceof Error) throw result
      return result
    },
  }
}

function fakeDownload() {
  const tasks: DownloadTask[] = []
  const download: typeof downloadOne = async (task) => {
    tasks.push(task)
    return {
      fileName: task.fileName,
      bytes: task.expectedSize,
      source: 'test',
      skipped: false,
      attempts: [],
    }
  }
  return { tasks, download }
}

const signal = new AbortController().signal
const layout = resolveLayout(dir, 'default')

test('本地已存在的包原样返回，不联网', async () => {
  const file = join(dir, 'local.mrpack')
  writeFileSync(file, 'x')
  const resolved = await resolvePackTarget({
    target: file,
    layout,
    source: sourceOf(new Error('不该被调用')),
    mirrors: [],
    signal,
  })
  assert.equal(resolved.path, file)
  assert.equal(resolved.remote, undefined)
})

test('像路径但不存在：原样返回，交给 createDeploy 报 BAD_MODPACK', async () => {
  for (const target of ['missing.zip', 'some/dir/pack', 'demo.mrpack']) {
    const resolved = await resolvePackTarget({
      target,
      layout,
      source: sourceOf(new Error('不该被调用')),
      mirrors: [],
      signal,
    })
    assert.equal(resolved.path, target)
  }
})

test('slug：下载 primary mrpack 到 cache/packs，并返回展示信息', async () => {
  const { tasks, download } = fakeDownload()
  const resolved = await resolvePackTarget({
    target: 'demo-pack',
    layout,
    source: sourceOf(version()),
    mirrors: [],
    signal,
    download,
  })
  assert.equal(resolved.path, join(dir, 'cache', 'packs', 'demo.mrpack'))
  assert.deepEqual(resolved.remote, {
    name: 'Demo Pack',
    versionId: 'pv1',
    fileName: 'demo.mrpack',
  })
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0]?.destPath, resolved.path)
  assert.equal(tasks[0]?.hashes.sha1, '00')
})

test('没有 primary 时退回第一个 mrpack，而不是普通 zip', async () => {
  const { download } = fakeDownload()
  const info = version({
    files: [
      {
        url: 'https://cdn.modrinth.com/data/pack/versions/pv1/extra.zip',
        filename: 'extra.zip',
        size: 1,
        primary: false,
        hashes: {},
      },
      {
        url: 'https://cdn.modrinth.com/data/pack/versions/pv1/second.mrpack',
        filename: 'second.mrpack',
        size: 2,
        primary: false,
        hashes: {},
      },
    ],
  })
  const resolved = await resolvePackTarget({
    target: 'demo-pack',
    layout,
    source: sourceOf(info),
    mirrors: [],
    signal,
    download,
  })
  assert.equal(resolved.remote?.fileName, 'second.mrpack')
})

test('slug 查不到 → PACK_NOT_FOUND', async () => {
  await assert.rejects(
    resolvePackTarget({
      target: 'nope',
      layout,
      source: sourceOf(null),
      mirrors: [],
      signal,
    }),
    (err: unknown) => err instanceof BlockPilotError && err.code === 'PACK_NOT_FOUND',
  )
})

test('没有任何可下载文件 → PACK_NO_FILE', async () => {
  await assert.rejects(
    resolvePackTarget({
      target: 'demo-pack',
      layout,
      source: sourceOf(version({ files: [] })),
      mirrors: [],
      signal,
    }),
    (err: unknown) => err instanceof BlockPilotError && err.code === 'PACK_NO_FILE',
  )
})

test('反查抛错 → PACK_QUERY_FAILED', async () => {
  await assert.rejects(
    resolvePackTarget({
      target: 'demo-pack',
      layout,
      source: sourceOf(new Error('network down')),
      mirrors: [],
      signal,
    }),
    (err: unknown) => err instanceof BlockPilotError && err.code === 'PACK_QUERY_FAILED',
  )
})

test('下载抛错 → PACK_DOWNLOAD_FAILED', async () => {
  const download: typeof downloadOne = async () => {
    throw new Error('disk full')
  }
  await assert.rejects(
    resolvePackTarget({
      target: 'demo-pack',
      layout,
      source: sourceOf(version()),
      mirrors: [],
      signal,
      download,
    }),
    (err: unknown) => err instanceof BlockPilotError && err.code === 'PACK_DOWNLOAD_FAILED',
  )
})

test('文件名指向 cache 之外 → PACK_UNSAFE_NAME', async () => {
  const info = version({
    files: [
      {
        url: 'https://cdn.modrinth.com/data/pack/versions/pv1/..',
        filename: '..',
        size: 1,
        primary: true,
        hashes: {},
      },
    ],
  })
  await assert.rejects(
    resolvePackTarget({
      target: 'demo-pack',
      layout,
      source: sourceOf(info),
      mirrors: [],
      signal,
      download: fakeDownload().download,
    }),
    (err: unknown) => err instanceof BlockPilotError && err.code === 'PACK_UNSAFE_NAME',
  )
})
