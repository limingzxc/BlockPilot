import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { detectEnv } from '../launch/env.js'
import { resolveLayout } from '../layout.js'
import type { Library, VersionJson } from '../version/types.js'
import {
  extractNativeJars,
  extractNatives,
  legacyNativeNames,
  nativeArtifact,
  nativeSubdir,
  usesSplitNatives,
} from './vanilla.js'

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
  assert.equal(usesSplitNatives(version(['-Djava.library.path=${natives_directory}/java'])), true)
  // 1.x 的写法：整包都解到 natives 根
  assert.equal(usesSplitNatives(version(['-Djava.library.path=${natives_directory}'])), false)
  assert.equal(usesSplitNatives(version([])), false)
})

test('原生库按 group 落子目录', () => {
  assert.equal(nativeSubdir(NATIVE_LIB), 'java')
  assert.equal(nativeSubdir({ name: 'net.java.dev.jna:jna:5.17.0' }), 'jna')
  assert.equal(
    nativeSubdir({ name: 'io.netty:netty-transport-native-epoll:4.2.15.Final' }),
    'netty',
  )
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

test('Legacy Fabric 的扁平 DLL 名要改成 LWJGL 2 的加载名（issue #15 / #19）', () => {
  // System.loadLibrary("lwjgl") 找的是 lwjgl.dll，只给 lwjgl64.dll 会报 no lwjgl
  assert.deepEqual(legacyNativeNames('lwjgl-windows-amd64.dll', 'x86_64'), [
    'lwjgl.dll',
    'lwjgl64.dll',
  ])
  assert.deepEqual(legacyNativeNames('lwjgl-windows-i386.dll', 'x86'), ['lwjgl.dll'])
  assert.deepEqual(legacyNativeNames('OpenAL-amd64.dll', 'x86_64'), ['OpenAL.dll', 'OpenAL64.dll'])
  assert.deepEqual(legacyNativeNames('OpenAL-i386.dll', 'x86'), ['OpenAL.dll'])
  assert.deepEqual(legacyNativeNames('jinput-dx8-amd64.dll', 'x86_64'), [
    'jinput-dx8.dll',
    'jinput-dx8_64.dll',
  ])
  assert.deepEqual(legacyNativeNames('jinput-raw-i386.dll', 'x86'), ['jinput-raw.dll'])
})

test('架构必须精确匹配，不能只分 32 / 64 位（issue #19）', () => {
  // 这台机器是 x86-64：aarch64 的那一份必须跳过，否则 JVM 报
  // Can't load ARM 64-bit .dll on a AMD 64-bit platform
  assert.equal(legacyNativeNames('lwjgl-windows-aarch64.dll', 'x86_64'), null)
  assert.equal(legacyNativeNames('lwjgl-windows-amd64.dll', 'arm64'), null)
  assert.equal(legacyNativeNames('lwjgl-windows-amd64.dll', 'x86'), null)
  assert.equal(legacyNativeNames('lwjgl-windows-i386.dll', 'x86_64'), null)
  assert.deepEqual(legacyNativeNames('lwjgl-windows-aarch64.dll', 'arm64'), [
    'lwjgl.dll',
    'lwjgl64.dll',
  ])
  // 其它文件原样保留
  assert.deepEqual(legacyNativeNames('lwjgl64.dll', 'x86_64'), ['lwjgl64.dll'])
  assert.deepEqual(legacyNativeNames('windows/x64/lwjgl.dll', 'x86_64'), ['windows/x64/lwjgl.dll'])
})

test('解压原生 jar 时按架构挑那一份，amd64 内容不会写成 ARM 的库', () => {
  const root = mkdtempSync(join(tmpdir(), 'blockpilot-natives2-'))
  try {
    const layout = resolveLayout(root, 'inst')
    const jarPath = join(root, 'lwjgl-platform-natives-windows.jar')
    writeFileSync(
      jarPath,
      zipSync({
        'lwjgl-windows-amd64.dll': strToU8('amd64'),
        'lwjgl-windows-aarch64.dll': strToU8('aarch64'),
        'lwjgl-windows-i386.dll': strToU8('i386'),
        'OpenAL-amd64.dll': strToU8('openal'),
        'META-INF/MANIFEST.MF': strToU8('x'),
      }),
    )
    const dest = layout.nativesDir('1.6.4')
    const count = extractNativeJars([jarPath], dest, { arch: 'x86_64' })
    // lwjgl 写两个名字 + OpenAL 写两个名字
    assert.equal(count, 4)
    assert.equal(readFileSync(join(dest, 'lwjgl.dll'), 'utf8'), 'amd64')
    assert.equal(readFileSync(join(dest, 'lwjgl64.dll'), 'utf8'), 'amd64')
    assert.equal(readFileSync(join(dest, 'OpenAL.dll'), 'utf8'), 'openal')
    assert.equal(readFileSync(join(dest, 'OpenAL64.dll'), 'utf8'), 'openal')
    // 32 位与 ARM 的那两份都不该出现
    for (const name of ['lwjgl-windows-i386.dll', 'lwjgl-windows-aarch64.dll']) {
      assert.equal(existsSync(join(dest, name)), false, name)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
