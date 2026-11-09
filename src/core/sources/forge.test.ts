import assert from 'node:assert/strict'
import test from 'node:test'

import { neoforgePrefix, recommendedNeoForge } from './forge.js'

async function withFetch(stub: typeof fetch, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('neoforgePrefix：20.x / 21.x 的映射，1.20.1 没有 NeoForge', () => {
  assert.equal(neoforgePrefix('1.20.1'), null)
  assert.equal(neoforgePrefix('1.20.4'), '20.4')
  assert.equal(neoforgePrefix('1.21'), '21.0')
  assert.equal(neoforgePrefix('1.21.1'), '21.1')
  assert.equal(neoforgePrefix('1.21.10'), '21.10')
  assert.equal(neoforgePrefix('26.1'), null)
})

test('recommendedNeoForge：按 semver 取最大，不按 XML 顺序', async () => {
  const xml = `<?xml version="1.0"?><metadata><versioning><versions>
    <version>21.1.9</version>
    <version>21.1.80</version>
    <version>21.1.100</version>
    <version>20.4.1</version>
  </versions></versioning></metadata>`
  const stub = (async () =>
    new Response(xml, {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    })) as typeof fetch
  await withFetch(stub, async () => {
    const probe = await recommendedNeoForge('1.21.1')
    assert.equal(probe.status, 'found')
    if (probe.status === 'found') assert.equal(probe.value, '21.1.100')
  })
})

test('recommendedNeoForge：不支持的 MC 不发请求', async () => {
  let called = false
  const stub = (async () => {
    called = true
    return new Response('')
  }) as typeof fetch
  await withFetch(stub, async () => {
    const probe = await recommendedNeoForge('1.20.1')
    assert.equal(probe.status, 'absent')
    assert.equal(called, false)
  })
})
