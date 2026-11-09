import assert from 'node:assert/strict'
import test from 'node:test'

import { ModrinthSource } from './modrinth.js'

async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

const RAW = [
  {
    id: 'beta1',
    project_id: 'abcd1234',
    name: 'Beta',
    version_type: 'beta',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: 'https://cdn.modrinth.com/data/abcd1234/versions/beta1/pack.mrpack',
        filename: 'pack-beta.mrpack',
        size: 1,
        primary: true,
        hashes: { sha1: 'a'.repeat(40) },
      },
    ],
  },
  {
    id: 'rel1',
    project_id: 'abcd1234',
    name: 'Release',
    version_type: 'release',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: 'https://cdn.modrinth.com/data/abcd1234/versions/rel1/pack.mrpack',
        filename: 'pack.mrpack',
        size: 2,
        primary: true,
        hashes: { sha1: 'b'.repeat(40) },
      },
    ],
  },
]

test('getLatestVersion 用 slug 查询并优先 release', async () => {
  let seen = ''
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    assert.match(String(headers['User-Agent'] ?? ''), /BlockPilot/)
    return new Response(JSON.stringify(RAW), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  await withFetch(stub, async () => {
    const info = await new ModrinthSource().getLatestVersion(
      'fabulously-optimized',
      new AbortController().signal,
    )
    assert.equal(info?.versionId, 'rel1')
    assert.match(seen, /\/project\/fabulously-optimized\/version$/)
  })
})

test('非法 slug 不发请求', async () => {
  let called = false
  const stub = (async () => {
    called = true
    return new Response('[]')
  }) as typeof fetch
  await withFetch(stub, async () => {
    const info = await new ModrinthSource().getLatestVersion(
      '../etc/passwd',
      new AbortController().signal,
    )
    assert.equal(info, null)
    assert.equal(called, false)
  })
})
