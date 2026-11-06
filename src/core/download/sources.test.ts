import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  adoptiumMirrorPath,
  adoptiumTunaSource,
  bmclapiSource,
  chinaFirstSources,
  createMirrorSource,
  defaultSources,
  directSource,
  mcimSource,
  neoforgeCdnSource,
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
  assert.deepEqual(names, ['bmclapi', 'neoforge-cdn', 'direct', 'mcim', 'adoptium-tuna'])
})

test('国内优先列表把 Adoptium 镜像与 MCIM 都提到直连之前', () => {
  assert.deepEqual(
    chinaFirstSources().map((s) => s.name),
    ['adoptium-tuna', 'bmclapi', 'neoforge-cdn', 'mcim', 'direct'],
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

test('neoforge-cdn 只换域名，路径原样（实测 200 的规则）', () => {
  const url = new URL('https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.264/neoforge-21.1.264-installer.jar')
  assert.equal(
    neoforgeCdnSource.rewrite(url),
    'https://neoforged.forgecdn.net/releases/net/neoforged/neoforge/21.1.264/neoforge-21.1.264-installer.jar',
  )
  // 对其他域不参与，不影响现有源
  assert.equal(neoforgeCdnSource.rewrite(new URL('https://libraries.minecraft.net/a/b.jar')), null)
  assert.equal(
    neoforgeCdnSource.rewrite(new URL('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml')),
    'https://neoforged.forgecdn.net/releases/net/neoforged/neoforge/maven-metadata.xml',
  )
})

test('Adoptium GitHub Release → 清华镜像路径', () => {
  const win = new URL(
    'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip',
  )
  assert.equal(
    adoptiumTunaSource.rewrite(win),
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jre/x64/windows/OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip',
  )

  // Linux / macOS 是 tar.gz，架构也进了路径
  const linux = new URL(
    'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_aarch64_linux_hotspot_25.0.5_8.tar.gz',
  )
  assert.equal(
    adoptiumTunaSource.rewrite(linux),
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jre/aarch64/linux/OpenJDK25U-jre_aarch64_linux_hotspot_25.0.5_8.tar.gz',
  )

  const mac = new URL(
    'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.5_8.tar.gz',
  )
  assert.equal(
    adoptiumMirrorPath(mac),
    '/25/jdk/aarch64/mac/OpenJDK25U-jdk_aarch64_mac_hotspot_25.0.5_8.tar.gz',
  )
})

test('Adoptium 镜像不碰其他 GitHub 包，也不碰非 GitHub 域', () => {
  // 同一个 GitHub 账号下的别的仓库，不是 Adoptium 运行时
  assert.equal(
    adoptiumTunaSource.rewrite(
      new URL('https://github.com/adoptium/temurin25-binaries/releases/download/v1/readme.txt'),
    ),
    null,
  )
  // Release 资产会 302 到 release-assets.githubusercontent.com，那一步不归这个源管
  assert.equal(
    adoptiumTunaSource.rewrite(
      new URL('https://release-assets.githubusercontent.com/github-production-release-asset/x/y.zip'),
    ),
    null,
  )
  // 文件名不像 Adoptium 的包（没有 OpenJDK..U-jre/jdk 前缀）
  assert.equal(
    adoptiumMirrorPath(
      new URL('https://github.com/adoptium/temurin25-binaries/releases/download/x/OpenJDK25-jre_x64_windows.zip'),
    ),
    null,
  )
})
