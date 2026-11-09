import assert from 'node:assert/strict'
import test from 'node:test'

import { listQuiltLoaders, pickQuiltLoaderVersion } from './quilt.js'

async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('Quilt 的「最新」按版本号取最大，不依赖列表顺序', () => {
  assert.equal(
    pickQuiltLoaderVersion(['0.20.0-beta.9', '0.29.2-beta.4', '0.17.0-beta.3']),
    '0.29.2-beta.4',
  )
  assert.equal(pickQuiltLoaderVersion([]), undefined)
})

test('列表接口：抽出 loader.version', async () => {
  const stub = (async () =>
    new Response(
      JSON.stringify([{ loader: { version: '0.20.0-beta.9' } }, { loader: { version: '0.21.0' } }]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch

  await withFetch(stub, async () => {
    const probe = await listQuiltLoaders('1.20.1')
    assert.equal(probe.status, 'found')
    if (probe.status === 'found') assert.deepEqual(probe.value, ['0.20.0-beta.9', '0.21.0'])
  })
})

test('404 是 absent，断网是 unreachable', async () => {
  const notFound = (async () => new Response('nope', { status: 404 })) as typeof fetch
  await withFetch(notFound, async () => {
    const probe = await listQuiltLoaders('0.0.0')
    assert.equal(probe.status, 'absent')
  })

  const offline = (async () => {
    throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })
  }) as typeof fetch
  await withFetch(offline, async () => {
    const probe = await listQuiltLoaders('1.20.1')
    assert.equal(probe.status, 'unreachable')
  })
})
