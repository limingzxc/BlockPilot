import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { resolveLayout } from '../layout.js'
import type { AssetIndex } from './index.js'
import { buildAssetTasks, probeAssetObjects, readAssetIndex } from './index.js'

const root = mkdtempSync(join(tmpdir(), 'bp-assets-'))
after(() => rmSync(root, { recursive: true, force: true }))

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const index: AssetIndex = {
  objects: {
    'minecraft/sounds/a.ogg': { hash: HASH_A, size: 100 },
    // 同一个 hash 被两个 key 引用 —— 必须去重
    'minecraft/sounds/a-copy.ogg': { hash: HASH_A, size: 100 },
    'minecraft/lang/en_us.json': { hash: HASH_B, size: 200 },
  },
}

test('按 hash 去重', () => {
  const tasks = buildAssetTasks(index, resolveLayout(root, 't'))
  assert.equal(tasks.length, 2, '3 个 key 去重后剩 2 个对象')
})

test('落地路径是 objects/<前两位>/<hash>', () => {
  const layout = resolveLayout(root, 't')
  const tasks = buildAssetTasks(index, layout)
  const taskA = tasks.find((t) => t.hashes['sha1'] === HASH_A)
  assert.ok(taskA)
  assert.ok(taskA.destPath.endsWith(join('objects', 'aa', HASH_A)))
})

test('下载 URL 指向 resources.download.minecraft.net 的原始规则', () => {
  const tasks = buildAssetTasks(index, resolveLayout(root, 't'))
  const taskB = tasks.find((t) => t.hashes['sha1'] === HASH_B)
  assert.ok(taskB)
  assert.equal(taskB.url, `https://resources.download.minecraft.net/bb/${HASH_B}`)
})

test('hash 同时作为 sha1 校验值', () => {
  const tasks = buildAssetTasks(index, resolveLayout(root, 't'))
  for (const t of tasks) {
    assert.equal(t.hashes['sha1'], t.fileName)
  }
})

test('readAssetIndex 读不到文件时给出可操作的提示', () => {
  const layout = resolveLayout(root, 't')
  assert.throws(() => readAssetIndex(layout.assetIndex('nope')), /找不到 asset index.*先跑 setup/)
})

test('readAssetIndex 能读真实写出的文件', () => {
  const layout = resolveLayout(root, 't')
  mkdirSync(join(layout.assets, 'indexes'), { recursive: true })
  writeFileSync(layout.assetIndex('9'), JSON.stringify(index))
  const parsed = readAssetIndex(layout.assetIndex('9'))
  assert.equal(Object.keys(parsed.objects).length, 3)
})

test('probeAssetObjects：index 在但 objects 空 → 抽查全缺', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-probe-'))
  try {
    const layout = resolveLayout(dir, 'default')
    mkdirSync(join(layout.assets, 'indexes'), { recursive: true })
    writeFileSync(
      layout.assetIndex('1.21.1'),
      JSON.stringify({ objects: { 'a/b.ogg': { hash: HASH_A, size: 1 } } }),
    )
    const probe = probeAssetObjects(layout.assetIndex('1.21.1'), join(layout.assets, 'objects'))
    assert.ok(probe)
    assert.equal(probe.total, 1)
    assert.equal(probe.present, 0)
    assert.deepEqual(probe.missingSample, [HASH_A])

    // 放上文件之后就通过
    mkdirSync(join(layout.assets, 'objects', HASH_A.slice(0, 2)), { recursive: true })
    writeFileSync(join(layout.assets, 'objects', HASH_A.slice(0, 2), HASH_A), 'x')
    const after = probeAssetObjects(layout.assetIndex('1.21.1'), join(layout.assets, 'objects'))
    assert.equal(after?.present, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeAssetObjects：index 不存在返回 null（不误报）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-probe-null-'))
  try {
    assert.equal(probeAssetObjects(join(dir, 'nope.json'), join(dir, 'objects')), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
