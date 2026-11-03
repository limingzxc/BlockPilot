import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchManifest } from './fetch.js'

const MANIFEST = {
  latest: { release: '1.21.1', snapshot: '1.21.2-pre1' },
  versions: [],
}

async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('--china 是「镜像优先」：镜像失败要退回官方，不能整条路断', async () => {
  const seen: string[] = []
  const stub = (async (url: string) => {
    seen.push(String(url))
    if (String(url).includes('bangbang93')) throw new TypeError('fetch failed')
    return ok(MANIFEST)
  }) as unknown as typeof fetch

  await withFetch(stub, async () => {
    const m = await fetchManifest({ mirror: true })
    assert.equal(m.latest.release, '1.21.1')
    assert.equal(seen.length, 2, '应先试镜像，再退官方')
    assert.match(seen[0] ?? '', /bangbang93/)
    assert.match(seen[1] ?? '', /piston-meta/)
  })
})

test('镜像可用时不碰官方', async () => {
  const seen: string[] = []
  const stub = (async (url: string) => {
    seen.push(String(url))
    return ok(MANIFEST)
  }) as unknown as typeof fetch

  await withFetch(stub, async () => {
    await fetchManifest({ mirror: true })
    assert.equal(seen.length, 1)
    assert.match(seen[0] ?? '', /bangbang93/)
  })
})

test('不给 --china 时不试镜像', async () => {
  const seen: string[] = []
  const stub = (async (url: string) => {
    seen.push(String(url))
    return ok(MANIFEST)
  }) as unknown as typeof fetch

  await withFetch(stub, async () => {
    await fetchManifest()
    assert.equal(seen.length, 1)
    assert.match(seen[0] ?? '', /piston-meta/)
  })
})

test('用户取消时不触发回退：Ctrl+C 不该变成一次新请求', async () => {
  const controller = new AbortController()
  controller.abort()
  const seen: string[] = []
  const stub = (async (url: string) => {
    seen.push(String(url))
    throw new TypeError('aborted')
  }) as unknown as typeof fetch

  await withFetch(stub, async () => {
    await assert.rejects(fetchManifest({ mirror: true, signal: controller.signal }))
    assert.equal(seen.length, 1)
  })
})
