import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchJson, NetworkError } from './http.js'

async function withFetch(
  stub: typeof fetch,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('传输失败包成 NetworkError：带地址与底层原因', async () => {
  const stub = (async () => {
    throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED 127.0.0.1:9') })
  }) as typeof fetch

  await withFetch(stub, async () => {
    await assert.rejects(fetchJson('https://example.invalid/v2/x'), (err: unknown) => {
      assert.ok(err instanceof NetworkError)
      assert.match(err.message, /无法访问 https:\/\/example\.invalid\/v2\/x/)
      assert.match(err.message, /ECONNREFUSED/)
      return true
    })
  })
})

test('超时也归到 NetworkError，并说明是超时', async () => {
  const stub = (async () => {
    const err = new Error('The operation was aborted due to timeout')
    err.name = 'TimeoutError'
    throw err
  }) as typeof fetch

  await withFetch(stub, async () => {
    await assert.rejects(fetchJson('https://slow.invalid/x'), (err: unknown) => {
      assert.ok(err instanceof NetworkError)
      assert.match(err.message, /请求超时/)
      return true
    })
  })
})

test('HTTP 非 2xx 不是网络错误：调用方要靠状态码区分', async () => {
  const stub = (async () => new Response('boom', { status: 500 })) as typeof fetch

  await withFetch(stub, async () => {
    await assert.rejects(fetchJson('https://example.invalid/x'), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.equal(err instanceof NetworkError, false)
      assert.match(err.message, /HTTP 500/)
      return true
    })
  })
})

test('超长查询串在消息里被截断', async () => {
  const stub = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const long = `https://api.example.invalid/versions?ids=${'a'.repeat(400)}`

  await withFetch(stub, async () => {
    await assert.rejects(fetchJson(long), (err: unknown) => {
      assert.ok(err instanceof NetworkError)
      assert.ok(err.message.length < 200, `消息应被截断，实际 ${String(err.message.length)} 字`)
      assert.equal(err.url, long, '完整地址仍保留在字段里')
      return true
    })
  })
})
