/**
 * 依赖方向守卫。
 *
 * ADR-0001 承诺「换实现只改 sources/，core 一行不动」。这条承诺靠人记是记不住的：
 * `core/deploy.ts` 曾经直接 import `sources/curseforge`，而 Modrinth 却是注入的，
 * 两种写法并存了很久。没有 lint 规则时，用一条测试守住同一个边界。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CORE = dirname(fileURLToPath(import.meta.url))

test('core 不 import 外层 sources / cli / mcp', () => {
  const violations: string[] = []

  for (const name of readdirSync(CORE, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const file = resolve(CORE, name)
    const text = readFileSync(file, 'utf8')
    // 同时覆盖静态 import 与动态 import()：core 不能因为换一种写法就绕过边界
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)'(\.[^']+)'/g)) {
      const spec = match[1] ?? ''
      const target = resolve(dirname(file), spec)
      if (/[\\/]src[\\/](sources|cli|mcp)[\\/]/.test(target)) {
        violations.push(`${name} -> ${spec}`)
      }
    }
  }

  assert.deepEqual(violations, [], 'core 只能依赖 core 内部与 node 内置模块')
})

test('core 不直接写 stdout/stderr', () => {
  const violations: string[] = []

  for (const name of readdirSync(CORE, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const text = readFileSync(resolve(CORE, name), 'utf8')
    for (const match of text.matchAll(/\bprocess\.(?:stdout|stderr)\s*\./g)) {
      violations.push(`${name}: ${match[0]}`)
    }
  }

  assert.deepEqual(violations, [], 'core 只能通过 OpEvent 输出；直接写 stdout/stderr 会绕过消费者')
})
