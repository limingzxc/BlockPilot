/**
 * E2E 用例表与执行器必须同步。
 *
 * `docs/testing/real-tests.md` 是手写表；新增用例只改 `scripts/e2e.ts` 的话，
 * 文档会静默过期。这里把两边当成两个集合比对，漏一个就红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./e2e.ts', import.meta.url))
const DOC = fileURLToPath(new URL('../docs/testing/real-tests.md', import.meta.url))

function scriptIds(): string[] {
  const text = readFileSync(SCRIPT, 'utf8')
  return [...text.matchAll(/id:\s*'(E2E-[0-9A-Z]+)'/g)].map((m) => m[1] ?? '')
}

function docIds(): string[] {
  const text = readFileSync(DOC, 'utf8')
  return [...text.matchAll(/^\|\s*(E2E-[0-9A-Z]+)\s*\|/gm)].map((m) => m[1] ?? '')
}

test('docs/testing/real-tests.md 与 scripts/e2e.ts 的用例集合一致', () => {
  const fromScript = [...new Set(scriptIds())].sort()
  const fromDoc = [...new Set(docIds())].sort()
  assert.deepEqual(fromDoc, fromScript)
})

test('scripts/e2e.ts 的用例 ID 不重复', () => {
  const ids = scriptIds()
  assert.equal(new Set(ids).size, ids.length)
})
