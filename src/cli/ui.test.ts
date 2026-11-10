import assert from 'node:assert/strict'
import test from 'node:test'

import { emitExit, sanitizeEventValue, setEventStream } from './ui.js'

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
