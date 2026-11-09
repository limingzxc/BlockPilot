/**
 * Finding 码表与代码必须同步。
 *
 * `code` 是 AI 与测试的公共锚点，但文档是手写的——没有这条测试，
 * 新增一个码只会让文档慢慢过期，而没人会发现。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { FINDING_CODES } from './types.js'

const DOC = fileURLToPath(new URL('../../../docs/finding-codes.md', import.meta.url))

test('docs/finding-codes.md 与 FINDING_CODES 一致', () => {
  const text = readFileSync(DOC, 'utf8')
  const listed = [...text.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1] ?? '')
  assert.deepEqual([...listed].sort(), [...FINDING_CODES].sort())
})

test('FINDING_CODES 没有重复项', () => {
  assert.equal(new Set(FINDING_CODES).size, FINDING_CODES.length)
})
