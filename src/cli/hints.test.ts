/**
 * 提示里的命令必须真的能敲。
 *
 * 做法：把渲染结果按 shell 规则切回 argv，用 CLI 自己的那张 flag 表校验一遍，
 * 再检查位置参数是不是「版本号」而不是内部 id。`assets 5` 这类错误就是
 * 靠这条用例挡住的（5 是 asset index id，不是 MC 版本）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assetsHint,
  diagHint,
  javaInstallHint,
  preflightHint,
  runHint,
  setupHint,
} from '../core/hints.js'
import { validateFlags } from './flags.js'
import { COMMANDS } from './index.js'

/** 够用的 shell 切分：支持双引号包住含空格的参数。 */
function splitArgs(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of command) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (ch === ' ' && !quoted) {
      if (cur !== '') out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

/** 解析并校验一条提示命令；返回去掉 `blockpilot` 后的 argv。 */
function check(command: string): string[] {
  const argv = splitArgs(command)
  assert.equal(argv[0], 'blockpilot', `命令要以 blockpilot 开头：${command}`)
  const cmd = argv[1]
  assert.ok(cmd !== undefined, `缺少子命令：${command}`)
  const spec = COMMANDS.find((c) => c.name === cmd)
  assert.ok(spec !== undefined, `子命令不存在：${cmd}（${command}）`)

  const args = argv.slice(2)
  const problem = validateFlags(args, spec.flags)
  assert.equal(problem, undefined, `${command} → ${String(problem)}`)
  return args
}

/** 位置参数必须是 MC 版本或加载器版本 id，不能是数字 id。 */
function assertVersionLike(value: string | undefined, command: string): void {
  assert.ok(value !== undefined, `缺少版本参数：${command}`)
  assert.match(
    value,
    /^\d+\.\d+|^(fabric|quilt|forge|neoforge)-/,
    `参数不像版本号：${value}（${command}）`,
  )
}

test('assets / setup / run 的版本参数是版本号，不是内部 id', () => {
  assertVersionLike(check(assetsHint('1.20.1'))[0], assetsHint('1.20.1'))
  assertVersionLike(check(setupHint('1.20.1'))[0], setupHint('1.20.1'))
  assertVersionLike(check(runHint('fabric-loader-0.19.3-1.21.1'))[0], 'run')

  // assets 的坑就是这里：1.20.1 的 index 叫 `5`，传 index id 会取 versions/5/5.json
  const bad = assetsHint('5')
  assert.throws(() => assertVersionLike(check(bad)[0], bad), /不像版本号/)
})

test('路径含空格时会被引号包住，切回来仍是完整路径', () => {
  const dir = 'C://Users//PC//WorkBuddy AI\\mc'
  for (const command of [preflightHint(dir), diagHint('C://a b', 'fo'), setupHint('1.20.1', dir)]) {
    check(command)
    assert.ok(command.includes(`"${dir}"`) || command.includes('"C://a b"'), command)
  }

  // 不引号的话会被切成两个参数——这里直接验证切分结果
  const args = check(diagHint('C://a b', 'fo'))
  assert.ok(args.includes('C://a b'), `路径被切碎了：${args.join('|')}`)
})

test('java install 的参数是数字大版本，不是版本串', () => {
  const args = check(javaInstallHint(21))
  assert.deepEqual(args, ['install', '21'])
})

test('提示里用到的 --flag 必须是某条命令真的声明过的', () => {
  const file = fileURLToPath(new URL('../core/hints.ts', import.meta.url))
  const text = readFileSync(file, 'utf8')
  const declared = new Set(COMMANDS.flatMap((c) => Object.keys(c.flags)))
  declared.add('--proxy')
  declared.add('--events')
  for (const match of text.matchAll(/--[a-z][a-z0-9-]*/g)) {
    assert.ok(declared.has(match[0]), `提示里出现了未声明的参数：${match[0]}`)
  }
})
