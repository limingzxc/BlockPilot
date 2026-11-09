/**
 * README 的命令表与 `COMMANDS` 必须同步。
 *
 * 这张表以前是手写的，加一条子命令就漏一次；漏了也不会有人发现，因为
 * README 不参与任何检查。这条测试把它变成会红的用例。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { COMMANDS } from './index.js'

const README = fileURLToPath(new URL('../../README.md', import.meta.url))

test('README 命令表列出全部子命令，且没有多余条目', () => {
  const text = readFileSync(README, 'utf8')
  const section = text.split('## 命令')[1]?.split('\n## ')[0] ?? ''
  const listed = [...section.matchAll(/^\| `([a-z]+)/gm)].map((m) => m[1] ?? '')
  assert.deepEqual([...listed].sort(), COMMANDS.map((c) => c.name).sort())
})
