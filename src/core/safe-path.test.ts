import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { isSafeRelative, safeJoin } from './safe-path.js'

const BASE = resolve('/tmp/bp-safe-path')

test('普通相对路径能拼接', () => {
  assert.equal(safeJoin(BASE, 'mods/a.jar'), join(BASE, 'mods', 'a.jar'))
  assert.equal(safeJoin(BASE, 'mods/../config/x.toml'), null, '.. 一律拒绝')
})

test('foo..bar 是合法文件名，不该被 includes("..") 误杀', () => {
  assert.equal(isSafeRelative('mods/foo..bar.jar'), true)
  assert.equal(safeJoin(BASE, 'mods/foo..bar.jar'), join(BASE, 'mods', 'foo..bar.jar'))
})

test('绝对路径、盘符、UNC 都拒绝', () => {
  for (const p of ['/etc/passwd', '\\windows\\x', 'C:/x', 'C:\\x', '//server/share/x']) {
    assert.equal(isSafeRelative(p), false, p)
    assert.equal(safeJoin(BASE, p), null, p)
  }
})

test('反斜杠形式的穿越也拒绝', () => {
  assert.equal(isSafeRelative('..\\evil.jar'), false)
  assert.equal(safeJoin(BASE, 'mods\\..\\..\\evil.jar'), null)
})

test('空路径与当前目录拒绝（落点就是 base 本身）', () => {
  assert.equal(safeJoin(BASE, ''), null)
  assert.equal(safeJoin(BASE, '.'), null)
})
