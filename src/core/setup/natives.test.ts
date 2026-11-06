import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'

import { resolveLayout } from '../layout.js'
import { detectEnv } from '../launch/env.js'
import type { Library, VersionJson } from '../version/types.js'
import { extractNatives, nativeArtifact, nativeSubdir, usesSplitNatives } from './vanilla.js'

const NATIVE_LIB: Library = {
  name: 'org.lwjgl:lwjgl:3.4.1:natives-windows',
  downloads: {
    artifact: {
      path: 'org/lwjgl/lwjgl/3.4.1/lwjgl-3.4.1-natives-windows.jar',
      sha1: '0000000000000000000000000000000000000000',
      size: 1,
      url: 'https://example.invalid/lwjgl.jar',
    },
  },
}

function version(jvm: readonly string[], library: Library = NATIVE_LIB): VersionJson {
  return {
    id: '26.2',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '32',
    libraries: [library],
    arguments: { game: [], jvm },
  }
}

/** 造一个只含一个 DLL 的原生库 jar，放在 layout 指向的 libraries 下 */
function makeRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'blockpilot-natives-'))
  const layout = resolveLayout(root, 'inst')
  const jarPath = join(layout.libraries, ...NATIVE_LIB.downloads!.artifact!.path.split('/'))
  mkdirSync(join(jarPath, '..'), { recursive: true })
  writeFileSync(
    jarPath,
    zipSync({ 'windows/x64/org/lwjgl/lwjgl.dll': strToU8('not really a dll') }),
  )
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('26.x 的 JVM 参数决定拆分布局', () => {
  assert.equal(
    usesSplitNatives(version(['-Djava.library.path=${natives_directory}/java'])),
    true,
  )
  // 1.x 的写法：整包都解到 natives 根
  assert.equal(usesSplitNatives(version(['-Djava.library.path=${natives_directory}'])), false)
  assert.equal(usesSplitNatives(version([])), false)
})

test('原生库按 group 落子目录', () => {
  assert.equal(nativeSubdir(NATIVE_LIB), 'java')
  assert.equal(nativeSubdir({ name: 'net.java.dev.jna:jna:5.17.0' }), 'jna')
  assert.equal(nativeSubdir({ name: 'io.netty:netty-transport-native-epoll:4.2.15.Final' }), 'netty')
  assert.equal(nativeSubdir({ name: 'com.example:foo:1.0' }), '')
})

test('拆分布局：DLL 落在 natives/<ver>/java 下', () => {
  const { root, cleanup } = makeRoot()
  try {
    const layout = resolveLayout(root, 'inst')
    const v = version(['-Djava.library.path=${natives_directory}/java'])
    const count = extractNatives(v, detectEnv(), layout)
    assert.equal(count, 1)
    assert.equal(
      existsSync(join(layout.nativesDir('26.2'), 'java', 'windows/x64/org/lwjgl/lwjgl.dll')),
      true,
    )
    // JNA / Netty 的目录也要先建好，运行时才不用自己 mkdir
    for (const sub of ['jna', 'lwjgl', 'netty']) {
      assert.equal(existsSync(join(layout.nativesDir('26.2'), sub)), true, sub)
    }
  } finally {
    cleanup()
  }
})

test('老布局：DLL 仍落在 natives/<ver> 根下', () => {
  const { root, cleanup } = makeRoot()
  try {
    const layout = resolveLayout(root, 'inst')
    const v = version(['-Djava.library.path=${natives_directory}'])
    const count = extractNatives(v, detectEnv(), layout)
    assert.equal(count, 1)
    assert.equal(
      existsSync(join(layout.nativesDir('26.2'), 'windows/x64/org/lwjgl/lwjgl.dll')),
      true,
    )
    assert.equal(existsSync(join(layout.nativesDir('26.2'), 'java')), false)
  } finally {
    cleanup()
  }
})

test('1.12 的老式 natives 走 downloads.classifiers', () => {
  const lib: Library = {
    name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209',
    natives: { windows: 'natives-windows', linux: 'natives-linux' },
    downloads: {
      artifact: { path: 'main.jar', sha1: 'x', size: 1, url: 'u' },
      classifiers: {
        'natives-windows': { path: 'win.jar', sha1: 'x', size: 1, url: 'u' },
        'natives-linux': { path: 'linux.jar', sha1: 'x', size: 1, url: 'u' },
      },
    },
  }
  const win = nativeArtifact(lib, { os: 'windows', arch: 'x86_64', features: {} })
  assert.equal(win?.path, 'win.jar')
  const linux = nativeArtifact(lib, { os: 'linux', arch: 'x86_64', features: {} })
  assert.equal(linux?.path, 'linux.jar')
  // 没有对应 classifier 时退回 artifact，不报错
  const mac = nativeArtifact(lib, { os: 'osx', arch: 'x86_64', features: {} })
  assert.equal(mac?.path, 'main.jar')
})

test('1.19+ 的 natives 仍然读 artifact', () => {
  const lib: Library = {
    name: 'org.lwjgl:lwjgl:3.4.1:natives-windows',
    downloads: { artifact: { path: 'lwjgl-natives.jar', sha1: 'x', size: 1, url: 'u' } },
  }
  const art = nativeArtifact(lib, { os: 'windows', arch: 'x86_64', features: {} })
  assert.equal(art?.path, 'lwjgl-natives.jar')
})
