import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { MARKER_FILE } from '../instance/identity.js'
import { resolveLayout } from '../layout.js'
import type { FabricProfile } from '../sources/fabric.js'
import type { LoaderInstallResult } from './loader-types.js'
import type { ProfileEventCodes } from './profile.js'
import { buildProfileTasks, installProfileLoader } from './profile.js'

const winEnv = { os: 'windows', arch: 'x86_64', features: {} } as const

function profile(libs: FabricProfile['libraries']): FabricProfile {
  return {
    id: 'fabric-loader-0.20.1-1.6.4',
    inheritsFrom: '1.6.4',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: libs,
  }
}

const CODES: ProfileEventCodes = {
  noHash: 'fabric.no_hash',
  versionJson: 'fabric.version_json',
  marker: 'fabric.marker',
  natives: 'fabric.natives',
  ok: 'fabric.ok',
  cached: 'fabric.cached',
  failed: 'fabric.failed',
  progressId: 'fabric',
}

test('Legacy Fabric 的原生库按 classifier 落盘，裸坐标不下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-fabric-native-'))
  try {
    const layout = resolveLayout(dir, 'default')
    const rel =
      'org/lwjgl/lwjgl/lwjgl-platform/2.9.4+legacyfabric.17/' +
      'lwjgl-platform-2.9.4+legacyfabric.17-natives-windows.jar'
    const dest = join(layout.libraries, ...rel.split('/'))
    // 预先放好，避开联网取 sha1 —— 这条用例只验路径推导与 nativeJars
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, 'x')

    const built = await buildProfileTasks(
      profile([
        {
          name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4+legacyfabric.17',
          url: 'https://maven.legacyfabric.net/',
          natives: { windows: 'natives-windows', linux: 'natives-linux' },
        },
      ]),
      layout,
      undefined,
      [],
      winEnv,
    )

    // 裸坐标不是可下载文件：不能进 tasks
    assert.equal(built.tasks.length, 0)
    assert.equal(built.nativeJars.length, 1)
    assert.match(built.nativeJars[0] ?? '', /natives-windows\.jar$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有 natives 的库照旧走 maven 解析（不误判成原生库）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-fabric-plain-'))
  try {
    const layout = resolveLayout(dir, 'default')
    const built = await buildProfileTasks(
      profile([
        // 预置到目标路径，避免为它取 sha1
        { name: 'net.fabricmc:fabric-loader:0.20.1', url: 'https://maven.fabricmc.net/' },
      ]),
      layout,
      undefined,
      [
        {
          name: 'noop',
          credit: 'noop',
          rewrite: () => null,
        },
      ],
      winEnv,
    )
    assert.equal(built.nativeJars.length, 0)
    assert.equal(built.noHash.length, 1, '拿不到 sha1 的库要报出来，不能静默跳过')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安装尾部：空 profile 也能落版本 JSON 与实例标记，结果归一', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-profile-install-'))
  try {
    const layout = resolveLayout(dir, 'default')
    const p = profile([])
    // 直接迭代而不是 for await：安装尾部的「结果」是 generator 的返回值，
    // 由 adapter 负责包成 result 事件
    const iterator = installProfileLoader(
      {
        kind: 'fabric',
        layout,
        gameVersion: '1.6.4',
        loaderVersion: '0.20.1',
        profile: p,
        sources: [],
        concurrency: 1,
        codes: CODES,
      },
      new AbortController().signal,
    )
    let result: LoaderInstallResult | undefined
    for (;;) {
      const step = await iterator.next()
      if (step.done === true) {
        result = step.value
        break
      }
      assert.notEqual(step.value.type, 'failed', '空 profile 不该产生 failed')
    }

    assert.equal(result?.versionId, p.id)
    assert.equal(result?.loaderVersion, '0.20.1')
    assert.equal(result?.versionJsonPath, layout.versionJson(p.id))
    assert.equal(result?.detail.kind, 'profile')
    assert.equal(result?.failed.length, 0)

    // 版本 JSON：下次启动不再回源拉 profile
    const written = JSON.parse(readFileSync(layout.versionJson(p.id), 'utf8')) as {
      id?: string
    }
    assert.equal(written.id, p.id)

    // 实例标记：preflight 能认出「1.6.4 + fabric 0.20.1」
    const marker = JSON.parse(readFileSync(join(layout.gameDir, MARKER_FILE), 'utf8')) as {
      components?: { uid?: string; version?: string }[]
    }
    assert.equal(marker.components?.find((c) => c.uid === 'net.minecraft')?.version, '1.6.4')
    assert.equal(
      marker.components?.find((c) => c.uid === 'net.fabricmc.fabric-loader')?.version,
      '0.20.1',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
