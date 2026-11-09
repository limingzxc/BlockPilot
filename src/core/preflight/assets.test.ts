import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assetsRequiredToBoot, checkAssets, gameVersionOf } from './assets.js'

const HASH = 'cc'.repeat(20)

test('实例目录的上一级有 assets 时能查到：零 objects → ASSETS_MISSING (blocker)', () => {
  // 布局与 setup --root <root> 之后一致：root/assets、root/instances/pack
  const root = mkdtempSync(join(tmpdir(), 'bp-assets-check-'))
  try {
    const instanceDir = join(root, 'instances', 'pack')
    mkdirSync(instanceDir, { recursive: true })
    mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })
    writeFileSync(
      join(root, 'assets', 'indexes', '1.21.1.json'),
      JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: HASH, size: 1 } } }),
    )

    const findings = checkAssets(instanceDir, '1.21.1')
    const f = findings.find((x) => x.code === 'ASSETS_MISSING')
    assert.ok(f, '要报 ASSETS_MISSING')
    assert.equal(f.severity, 'blocker')
    assert.match(f.message, /一个都没装/)
    assert.match(f.hint ?? '', /blockpilot assets 1\.21\.1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('部分缺失按 warning；装齐了不报', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-assets-partial-'))
  try {
    const instanceDir = join(root, 'instances', 'pack')
    mkdirSync(instanceDir, { recursive: true })
    const objectsDir = join(root, 'assets', 'objects')
    mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })

    const objects: Record<string, { hash: string; size: number }> = {}
    for (let i = 0; i < 30; i += 1) {
      const hash = i.toString(16).padStart(2, '0').repeat(20)
      objects[`a/${i}`] = { hash, size: 1 }
      // 只放一半
      if (i % 2 === 0) {
        mkdirSync(join(objectsDir, hash.slice(0, 2)), { recursive: true })
        writeFileSync(join(objectsDir, hash.slice(0, 2), hash), 'x')
      }
    }
    writeFileSync(join(root, 'assets', 'indexes', '1.21.1.json'), JSON.stringify({ objects }))

    const partial = checkAssets(instanceDir, '1.21.1').find((f) => f.code === 'ASSETS_MISSING')
    assert.ok(partial)
    assert.equal(partial.severity, 'warning')
    assert.match(partial.message, /不完整/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有 assets 目录时一声不响（别人的安装不归我们管）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-assets-none-'))
  try {
    assert.equal(checkAssets(dir, '1.21.1').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('提示里给的是 MC 版本，不是 asset index id（1.20.1 的 index 叫 5）', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-assets-indexid-'))
  try {
    const instanceDir = join(root, 'instances', 'pack')
    mkdirSync(instanceDir, { recursive: true })
    mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })
    writeFileSync(
      join(root, 'assets', 'indexes', '5.json'),
      JSON.stringify({ objects: { 'a/b.ogg': { hash: HASH, size: 1 } } }),
    )

    // 版本号与 index id 不一致：照 index id 敲 `assets 5` 会 404
    const f = checkAssets(instanceDir, '1.20.1').find((x) => x.code === 'ASSETS_MISSING')
    assert.ok(f)
    assert.match(f.hint ?? '', /blockpilot assets 1\.20\.1/)
    assert.doesNotMatch(f.hint ?? '', /assets 5 /)
    // 但消息里仍要说清用的是哪份 index，方便核对
    assert.match(f.message, /index 5/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('assets 是否致命按版本分：1.19+ 必崩，1.12 及更早只是没声音', () => {
  assert.equal(assetsRequiredToBoot('1.21.1'), true)
  assert.equal(assetsRequiredToBoot('26.2'), true, '新命名一律按新版本处理')
  assert.equal(assetsRequiredToBoot('1.12.2'), false)
  assert.equal(assetsRequiredToBoot('1.6.4'), false)
  assert.equal(assetsRequiredToBoot('unknown'), false, '版本未知时不做断言')
})

test('加载器版本 id 也能剥出 MC 版本（issue #18）', () => {
  assert.equal(gameVersionOf('fabric-loader-0.20.1-1.6.4'), '1.6.4')
  assert.equal(gameVersionOf('quilt-loader-0.20.0-1.20.1'), '1.20.1')
  assert.equal(gameVersionOf('1.20.1-forge-47.2.0'), '1.20.1')
  assert.equal(gameVersionOf('1.6.4'), '1.6.4')
  assert.equal(gameVersionOf('26.4-snapshot-1'), undefined)

  // 关键：带前缀的 1.6.4 不能再被判成「会崩在标题画面」
  assert.equal(assetsRequiredToBoot('fabric-loader-0.20.1-1.6.4'), false)
  assert.equal(assetsRequiredToBoot('fabric-loader-0.19.3-1.21.1'), true)
})

test('1.6.4 零 assets：只报 warning，不给「会崩」的建议', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-assets-legacy-'))
  try {
    const instanceDir = join(root, 'instances', 'btw')
    mkdirSync(instanceDir, { recursive: true })
    mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })
    writeFileSync(
      join(root, 'assets', 'indexes', 'legacy.json'),
      JSON.stringify({ objects: { 'minecraft/sounds/a.ogg': { hash: HASH, size: 1 } } }),
    )

    const f = checkAssets(instanceDir, '1.6.4').find((x) => x.code === 'ASSETS_MISSING')
    assert.ok(f)
    assert.equal(f.severity, 'warning')
    assert.match(f.hint ?? '', /不影响启动/)
    assert.doesNotMatch(f.hint ?? '', /崩在标题画面/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
