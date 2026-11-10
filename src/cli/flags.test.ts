import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeFlags, validateFlags } from './flags.js'

const spec = normalizeFlags({
  '--china': '镜像优先',
  '--root': { takesValue: true, value: '<dir>', help: '根目录' },
  '--jvm-args': { takesValue: true, value: '<args>', help: '追加 JVM 参数' },
})

test('以 -- 开头的值只要不是已知 flag，就当作值接受', () => {
  const problem = validateFlags(
    ['--jvm-args', '--add-opens', 'java.base/java.lang=ALL-UNNAMED'],
    spec,
  )
  assert.equal(problem, undefined)
})

test('值恰好是另一个已知 flag 时仍报「需要一个值」', () => {
  assert.match(validateFlags(['--root', '--china'], spec) ?? '', /需要一个值/)
})
