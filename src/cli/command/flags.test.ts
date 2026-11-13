import assert from 'node:assert/strict'
import test from 'node:test'
import { positional } from '../shared/args.js'
import type { CommandContext } from './context.js'
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

const ctx = (argv: string[]): CommandContext => ({ argv, flags: spec }) as unknown as CommandContext

test('位置参数可以写在 flag 后面：deploy --root D:/mc pack.mrpack', () => {
  assert.equal(positional(ctx(['--root', 'D:/mc', 'pack.mrpack'])), 'pack.mrpack')
  // 不取值的开关只跳过自己，不能把后面的位置参数一起吞掉
  assert.equal(positional(ctx(['--china', 'pack.mrpack'])), 'pack.mrpack')
  // flag 的值长得像位置参数也不能当目标
  assert.equal(positional(ctx(['--root', 'D:/mc'])), undefined)
})
