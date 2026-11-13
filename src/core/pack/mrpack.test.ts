import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { readMrpackIndex } from './mrpack.js'

const BASE = {
  formatVersion: 1,
  name: 'x',
  versionId: '1.0.0',
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.19.3' },
  files: [] as unknown[],
}

/** 写一个临时 mrpack，跑断言，然后清理。 */
function withPack(files: Record<string, Uint8Array>, fn: (p: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-mrpack-'))
  const p = join(dir, 'x.mrpack')
  writeFileSync(p, Buffer.from(zipSync(files)))
  try {
    fn(p)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function withIndex(index: unknown, fn: (p: string) => void): void {
  withPack({ 'modrinth.index.json': strToU8(JSON.stringify(index)) }, fn)
}

function expectMessage(index: unknown, re: RegExp): void {
  withIndex(index, (p) => {
    assert.throws(
      () => readMrpackIndex(p),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, re)
        return true
      },
    )
  })
}

test('正常清单能读出来', () => {
  withIndex(BASE, (p) => {
    const idx = readMrpackIndex(p)
    assert.equal(idx.dependencies['minecraft'], '1.21.1')
    assert.deepEqual(idx.files, [])
  })
})

test('缺 dependencies 给的是人话，不是 TypeError', () => {
  // 这个形状以前抛 `Cannot use 'in' operator to search for 'fabric-loader' in undefined`
  expectMessage({ ...BASE, dependencies: undefined }, /清单缺少 dependencies/)
})

test('dependencies 里没有 minecraft', () => {
  expectMessage({ ...BASE, dependencies: { 'fabric-loader': '0.19.3' } }, /没有 minecraft 版本/)
})

test('不认的清单格式版本要拒绝，不能假装看懂了', () => {
  expectMessage({ ...BASE, formatVersion: 99 }, /不支持的清单格式版本 99/)
})

test('files 里的路径不能穿越出实例目录', () => {
  // buildPackTasks 会用 join(gameDir, path) 落盘，`..` 会甩到实例外面
  expectMessage(
    {
      ...BASE,
      files: [
        {
          path: '../../evil.jar',
          hashes: { sha1: 'a'.repeat(40) },
          downloads: ['https://example.invalid/x.jar'],
          fileSize: 1,
        },
      ],
    },
    /路径不安全/,
  )
})

test('反斜杠写的穿越同样拦住', () => {
  expectMessage(
    {
      ...BASE,
      files: [{ path: '..\\..\\evil.jar', hashes: {}, downloads: [], fileSize: 1 }],
    },
    /路径不安全/,
  )
})

test('缺 downloads 数组', () => {
  expectMessage(
    { ...BASE, files: [{ path: 'mods/a.jar', hashes: {}, fileSize: 1 }] },
    /缺少 downloads 数组/,
  )
})

test('清单不是合法 JSON', () => {
  withPack({ 'modrinth.index.json': strToU8('{ not json') }, (p) => {
    assert.throws(() => readMrpackIndex(p), /不是合法 JSON/)
  })
})
