import assert from 'node:assert/strict'
import test from 'node:test'

import { Op } from '../core/events.js'
import { defineOperation } from '../core/operation.js'
import { consume, emitExit, sanitizeEventValue, setEventStream } from './ui.js'

test('login 的 result 里 accessToken / refreshToken 都被兜底脱敏', () => {
  const clean = sanitizeEventValue({
    type: 'result',
    value: {
      name: 'Steve',
      uuid: '0'.repeat(32),
      accessToken: 'short-lived-secret',
      refreshToken: 'long-lived-secret',
      expiresAt: 1,
      obtainedAt: 1,
    },
  }) as { value: Record<string, unknown> }
  assert.equal(clean.value.accessToken, '***')
  assert.equal(clean.value.refreshToken, '***')
  assert.equal(clean.value.name, 'Steve')
})

test('launch 的 result.args 成对脱敏 --accessToken', () => {
  const clean = sanitizeEventValue({
    type: 'result',
    value: {
      args: ['-cp', 'x', '--accessToken', 'real-token', '--username', 'Steve'],
      commandLine: 'java -cp x --accessToken real-token',
    },
  }) as { value: { args: string[]; commandLine: string } }
  assert.deepEqual(clean.value.args, ['-cp', 'x', '--accessToken', '***', '--username', 'Steve'])
  assert.doesNotMatch(clean.value.commandLine, /real-token/)
})

test('日志文本里的 1.6.x Session ID 也会被脱敏', () => {
  const clean = sanitizeEventValue('Session ID is token:secret:00000000000000000000000000000000')
  assert.doesNotMatch(String(clean), /secret/)
})

test('exit 行只写一次：串联多个 Operation 也不能出现两个退出码', () => {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    setEventStream(true)
    assert.equal(emitExit(0), true)
    assert.equal(emitExit(2), false)
  } finally {
    process.stdout.write = original
    setEventStream(false)
  }
  const exits = chunks.filter((c) => c.includes('"type":"exit"'))
  assert.equal(exits.length, 1)
  assert.match(exits[0] ?? '', /"code":0/)
})

test('同一条命令在普通模式与 --events 下退出码一致', async () => {
  const op = defineOperation<number>('test-exit', async function* () {
    yield Op.result(2)
    yield Op.done()
  })
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    const signal = new AbortController().signal
    // 只渲染、不改退出码：以前 result 自己也算一遍，漏写 exitCode 时两边会分叉
    const ui = { progress: () => {}, log: () => {}, result: () => {}, exitCode: () => 2 }
    setEventStream(false)
    const plain = await consume(op, ui, signal)
    setEventStream(true)
    const events = await consume(op, ui, signal)
    assert.equal(plain, 2)
    assert.equal(events, plain)
  } finally {
    process.stdout.write = original
    setEventStream(false)
  }
  // 事件模式下 result 事件照发；exit 行由全局一次性开关控制，这里只验退出码
  assert.match(chunks.join(''), /"type":"result"/)
})
