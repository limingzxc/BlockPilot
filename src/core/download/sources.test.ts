import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  bmclapiSource,
  chinaFirstSources,
  createMirrorSource,
  defaultSources,
  directSource,
  mcimSource,
} from './sources.js'

const u = (s: string): URL => new URL(s)

test('BMCLAPI 重写 Mojang 库路径', () => {
  const out = bmclapiSource.rewrite(
    u('https://libraries.minecraft.net/com/mojang/logging/1.1.1/logging-1.1.1.jar'),
  )
  assert.equal(
    out,
    'https://bmclapi2.bangbang93.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar',
  )
})

test('BMCLAPI 重写 assets 路径', () => {
  const out = bmclapiSource.rewrite(
    u('https://resources.download.minecraft.net/ab/abcdef0123456789'),
  )
  assert.equal(out, 'https://bmclapi2.bangbang93.com/assets/ab/abcdef0123456789')
})

test('BMCLAPI 不覆盖 Modrinth CDN，返回 null', () => {
  assert.equal(bmclapiSource.rewrite(u('https://cdn.modrinth.com/data/AANobbMI/x.jar')), null)
})

test('MCIM 重写 Modrinth CDN，路径不变', () => {
  const out = mcimSource.rewrite(
    u('https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium.jar'),
  )
  assert.equal(out, 'https://mod.mcimirror.top/data/AANobbMI/versions/OihdIimA/sodium.jar')
})

test('MCIM 重写 CurseForge CDN', () => {
  const out = mcimSource.rewrite(u('https://edge.forgecdn.net/files/1234/567/mod.jar'))
  assert.equal(out, 'https://mod.mcimirror.top/files/1234/567/mod.jar')
})

test('MCIM 不覆盖 Mojang 域', () => {
  assert.equal(mcimSource.rewrite(u('https://libraries.minecraft.net/a/b.jar')), null)
})

test('直连源原样返回，永不返回 null', () => {
  const raw = 'https://cdn.modrinth.com/data/AANobbMI/x.jar'
  assert.equal(directSource.rewrite(u(raw)), raw)
})

test('默认源列表里 BMCLAPI 在 Modrinth 之前，MCIM 在直连之后', () => {
  const names = defaultSources().map((s) => s.name)
  assert.deepEqual(names, ['bmclapi', 'direct', 'mcim'])
})

test('国内优先列表把 MCIM 提到直连之前', () => {
  assert.deepEqual(
    chinaFirstSources().map((s) => s.name),
    ['bmclapi', 'mcim', 'direct'],
  )
})

test('createMirrorSource 支持自定义镜像', () => {
  const m = createMirrorSource({
    name: 'my-mirror',
    from: 'maven.minecraftforge.net',
    to: 'https://example.com/repo/',
    pathPrefix: '/maven',
    credit: 'MyMirror',
  })
  assert.equal(
    m.rewrite(u('https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1/x.jar')),
    'https://example.com/repo/maven/net/minecraftforge/forge/1.20.1/x.jar',
  )
  assert.equal(m.rewrite(u('https://cdn.modrinth.com/a.jar')), null)
})
