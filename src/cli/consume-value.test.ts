import assert from 'node:assert/strict'
import test from 'node:test'

import { Op } from '../core/events.js'
import { defineOperation } from '../core/operation.js'
import { consumeValue, setEventStream } from './ui.js'

const valueOp = defineOperation<number>('test-value', async function* () {
  yield Op.result(42)
  yield Op.done()
})

function captureStdout(): { chunks: string[]; restore(): void } {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  return {
    chunks,
    restore: () => {
      process.stdout.write = original
    },
  }
}

test('consumeValue 在 --events 模式下也能拿到中间 result', async () => {
  const out = captureStdout()
  try {
    setEventStream(true)
    const r = await consumeValue(valueOp, { exitEvent: false }, new AbortController().signal)
    assert.equal(r.code, 0)
    assert.equal(r.value, 42)
    // 中间步骤只发 result，不写 exit
    assert.equal(out.chunks.length, 1)
    assert.match(out.chunks[0] ?? '', /"type":"result"/)
  } finally {
    setEventStream(false)
    out.restore()
  }
})

test('consumeValue 在普通模式下拿到值，且不渲染中间结果', async () => {
  const out = captureStdout()
  try {
    setEventStream(false)
    const r = await consumeValue(valueOp, { exitEvent: false }, new AbortController().signal)
    assert.equal(r.code, 0)
    assert.equal(r.value, 42)
    assert.equal(out.chunks.join(''), '')
  } finally {
    out.restore()
  }
})
