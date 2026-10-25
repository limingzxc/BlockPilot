import assert from 'node:assert/strict'
import test from 'node:test'

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

import { mirrorNeoForgeInstaller } from './forge.js'

/** 造一个假 installer：结构照抄真包的三个关键条目 */
function fakeInstaller(): Uint8Array {
  // 在 class 里塞一个 maven.neoforged.net 的字节串，验证二进制条目不被动
  const classBytes = new TextEncoder().encode('maven.neoforged.net')
  return zipSync({
    'META-INF/MANIFEST.MF': strToU8('Manifest-Version: 1.0\nMain-Class: net.minecraftforge.installer.SimpleInstaller\n'),
    'install_profile.json': strToU8(JSON.stringify({
      maven: 'https://maven.neoforged.net/releases/',
      libraries: [{ name: 'net.neoforged:bus:8.0.5', url: 'https://maven.neoforged.net/releases/' }],
    })),
    'version.json': strToU8(JSON.stringify({ id: 'neoforge-21.1.264', libraries: [{ url: 'https://maven.neoforged.net/releases/' }] })),
    'net/minecraftforge/installer/SimpleInstaller.class': classBytes,
    'data/client.lzma': strToU8(new Array(600).fill('x').join('')),
  })
}

test('重打包只改两个 JSON，二进制与其他条目原样', () => {
  const mirrored = mirrorNeoForgeInstaller(fakeInstaller())
  const entries = unzipSync(mirrored)

  // JSON 里的 URL 全部换成镜像
  const profile = JSON.parse(strFromU8(entries['install_profile.json'] ?? new Uint8Array()))
  assert.equal(profile.maven, 'https://neoforged.forgecdn.net/releases/')
  assert.equal(profile.libraries[0]?.url, 'https://neoforged.forgecdn.net/releases/')
  const version = JSON.parse(strFromU8(entries['version.json'] ?? new Uint8Array()))
  assert.equal(version.libraries[0]?.url, 'https://neoforged.forgecdn.net/releases/')

  // JSON 里不允许残留官方域名
  assert.equal(strFromU8(entries['install_profile.json'] ?? new Uint8Array()).includes('maven.neoforged.net'), false)

  // class 的字节原样——包括塞进去的 maven.neoforged.net 字节串
  const cls = entries['net/minecraftforge/installer/SimpleInstaller.class'] ?? new Uint8Array()
  assert.equal(new TextDecoder().decode(cls.slice(0, 19)), 'maven.neoforged.net')

  // 无关条目不受影响
  assert.equal(strFromU8(entries['META-INF/MANIFEST.MF'] ?? new Uint8Array()).includes('Main-Class'), true)
  assert.equal((entries['data/client.lzma'] ?? new Uint8Array()).length, 600)
})

test('重打包产物仍是合法 zip 且条目数不变', () => {
  const before = Object.keys(unzipSync(fakeInstaller())).sort()
  const after = Object.keys(unzipSync(mirrorNeoForgeInstaller(fakeInstaller()))).sort()
  assert.deepEqual(after, before)
})
