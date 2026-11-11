import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { MARKER_FILE, writeInstanceMarker } from './marker.js'

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-marker-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function read(dir: string): { components?: { uid?: string; version?: string }[] } {
  return JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as {
    components?: { uid?: string; version?: string }[]
  }
}

function component(dir: string, uid: string): string | undefined {
  return read(dir).components?.find((c) => c.uid === uid)?.version
}

test('写原版标记', () => {
  withTemp((dir) => {
    writeInstanceMarker(dir, { gameVersion: '1.21.1' })
    assert.equal(component(dir, 'net.minecraft'), '1.21.1')
  })
})

test('先 setup 再装加载器：MC 版本不被抹掉', () => {
  withTemp((dir) => {
    writeInstanceMarker(dir, { gameVersion: '1.21.1' })
    writeInstanceMarker(dir, {
      gameVersion: '1.21.1',
      loader: { kind: 'fabric', version: '0.19.3' },
    })
    assert.equal(component(dir, 'net.minecraft'), '1.21.1')
    assert.equal(component(dir, 'net.fabricmc.fabric-loader'), '0.19.3')
  })
})

test('重跑 setup：已有加载器信息保留', () => {
  withTemp((dir) => {
    writeInstanceMarker(dir, {
      gameVersion: '1.20.1',
      loader: { kind: 'forge', version: '47.2.0' },
    })
    writeInstanceMarker(dir, { gameVersion: '1.20.1' })
    assert.equal(component(dir, 'net.minecraftforge'), '47.2.0')
  })
})

test('换加载器：旧加载器组件必须移除', () => {
  withTemp((dir) => {
    writeInstanceMarker(dir, {
      gameVersion: '1.20.1',
      loader: { kind: 'fabric', version: '0.15.0' },
    })
    writeInstanceMarker(dir, {
      gameVersion: '1.20.1',
      loader: { kind: 'forge', version: '47.2.0' },
    })
    // 残留的 Fabric 组件会让 scan 继续把实例判成 Fabric，新包的模组全被跳过
    assert.equal(component(dir, 'net.fabricmc.fabric-loader'), undefined)
    assert.equal(component(dir, 'net.minecraftforge'), '47.2.0')
  })
})

test('标记文件损坏时当作不存在，不让安装失败', () => {
  withTemp((dir) => {
    writeFileSync(join(dir, MARKER_FILE), '{ 坏掉的 json')
    writeInstanceMarker(dir, { gameVersion: '1.20.1' })
    assert.equal(component(dir, 'net.minecraft'), '1.20.1')
  })
})

test('未知顶层字段不被覆盖（Prism 可能写了自己的东西）', () => {
  withTemp((dir) => {
    writeFileSync(
      join(dir, MARKER_FILE),
      JSON.stringify({ formatVersion: 1, components: [], name: 'keep me' }),
    )
    writeInstanceMarker(dir, { gameVersion: '1.20.1' })
    const raw = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as { name?: string }
    assert.equal(raw.name, 'keep me')
  })
})
