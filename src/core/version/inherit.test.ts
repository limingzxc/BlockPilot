import assert from 'node:assert/strict'
import { test } from 'node:test'

import { libraryKey, mergeVersionJson } from './inherit.js'
import type { Library, VersionJson } from './types.js'

function lib(name: string): Library {
  return { name }
}

test('libraryKey 保留 classifier，但忽略版本', () => {
  assert.equal(libraryKey(lib('org.lwjgl:lwjgl:3.3.1')), 'org.lwjgl:lwjgl')
  assert.equal(
    libraryKey(lib('org.lwjgl:lwjgl:3.3.1:natives-windows')),
    'org.lwjgl:lwjgl:natives-windows',
  )
  // 版本不同但身份相同 → 同一个 key，用于「加载器覆盖原版」
  assert.equal(libraryKey(lib('org.ow2.asm:asm:9.7')), libraryKey(lib('org.ow2.asm:asm:9.10.1')))
})

function base(): VersionJson {
  return {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', sha1: 'x', size: 1, url: 'u' },
    downloads: { client: { path: 'x', sha1: 'x', size: 1, url: 'u' } },
    libraries: [
      lib('org.lwjgl:lwjgl:3.3.1'),
      lib('org.lwjgl:lwjgl:3.3.1:natives-windows'),
      lib('org.ow2.asm:asm:9.7'),
      lib('com.google.guava:guava:31.1-jre'),
    ],
    arguments: {
      jvm: ['-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}'],
    },
  }
}

function child(): VersionJson {
  return {
    id: 'fabric-loader-0.15.11-1.20.1',
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    assets: '5',
    inheritsFrom: '1.20.1',
    libraries: [lib('org.ow2.asm:asm:9.10.1'), lib('net.fabricmc:fabric-loader:0.15.11')],
    arguments: { jvm: ['-DFabricMcEmu=net.minecraft.client.main.Main'], game: [] },
  }
}

test('natives 变体不能被当成同一个库合并掉', () => {
  const merged = mergeVersionJson(base(), child())
  const lwjgl = merged.libraries.filter((l) => l.name.startsWith('org.lwjgl:lwjgl:'))
  assert.equal(lwjgl.length, 2, '主 jar 与 natives 变体都要保留')
  assert.ok(lwjgl.some((l) => l.name.endsWith(':natives-windows')))
  assert.ok(lwjgl.some((l) => !l.name.includes('natives')))
})

test('加载器的库版本覆盖原版', () => {
  const merged = mergeVersionJson(base(), child())
  const asm = merged.libraries.filter((l) => l.name.startsWith('org.ow2.asm:asm:'))
  assert.equal(asm.length, 1)
  assert.equal(asm[0]?.name, 'org.ow2.asm:asm:9.10.1')
})

test('加载器自己的库被加进来', () => {
  const merged = mergeVersionJson(base(), child())
  assert.ok(merged.libraries.some((l) => l.name.includes('fabric-loader')))
})

test('arguments 是拼接而不是替换', () => {
  const merged = mergeVersionJson(base(), child())
  const jvm = merged.arguments?.jvm ?? []
  assert.ok(jvm.includes('-cp'), '父的 -cp 必须保留')
  assert.ok(jvm.some((a) => typeof a === 'string' && a.startsWith('-DFabricMcEmu')))
  assert.equal(jvm.length, 3)
})

test('mainClass 被子版本覆盖', () => {
  assert.equal(
    mergeVersionJson(base(), child()).mainClass,
    'net.fabricmc.loader.impl.launch.knot.KnotClient',
  )
})

test('子版本没给的字段保留父版本的', () => {
  const merged = mergeVersionJson(base(), child())
  assert.ok(merged.downloads?.client, '子 profile 没有 downloads，必须继承')
  assert.equal(merged.assetIndex?.id, '5')
})
