import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'
import { scanInstanceDir } from '../instance/scan.js'
import type { LoaderKind } from '../instance.js'
import { checkLocalInstance } from './local.js'

function withInstances(
  jars: Record<string, Uint8Array | string>,
  fn: (scan: ReturnType<typeof scanInstanceDir>) => void,
  loader: LoaderKind = 'fabric',
): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-preflight-'))
  try {
    mkdirSync(join(dir, 'mods'), { recursive: true })
    for (const [name, content] of Object.entries(jars)) {
      writeFileSync(join(dir, 'mods', name), content)
    }
    fn(
      scanInstanceDir(dir, {
        fallbackGameVersion: '1.20.1',
        fallbackLoader: { kind: loader, version: loader === 'forge' ? '47.2.0' : '0.15.11' },
      }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('损坏的 jar 报 warning，并点出文件名；缺元数据的正常 jar 只报 info', () => {
  withInstances(
    {
      // 下载中断的形状：只有半截字节
      'broken-mod-1.0.jar': new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]),
      // 合法 zip，但没有模组元数据（资源包/老库改名）
      'not-a-mod.jar': zipSync({ 'pack.mcmeta': strToU8('{}') }),
      'good.jar': zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'good', version: '1.0.0' })),
      }),
    },
    (scan) => {
      assert.deepEqual(scan.corrupt, ['broken-mod-1.0.jar'])
      assert.equal(scan.mods.length, 1)

      const findings = checkLocalInstance(scan, {
        gameVersion: '1.20.1',
        loaderVersion: '0.15.11',
      })
      const corrupt = findings.find((f) => f.code === 'CORRUPT_JAR')
      assert.ok(corrupt, '要有 CORRUPT_JAR')
      assert.equal(corrupt.severity, 'warning')
      assert.match(corrupt.hint ?? '', /broken-mod-1\.0\.jar/)
      assert.match(corrupt.hint ?? '', /重新下载|删掉重下/)

      const unreadable = findings.find((f) => f.code === 'UNREADABLE_JAR')
      assert.ok(unreadable)
      assert.equal(unreadable.severity, 'info')
      assert.doesNotMatch(unreadable.hint ?? '', /broken-mod/, '损坏的那份不该同时算作「没元数据」')
    },
  )
})

test('重复 modId：两份 jar 都算 blocker', () => {
  withInstances(
    {
      'a.jar': zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'dup', version: '1.0.0' })),
      }),
      'b.jar': zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'dup', version: '1.0.1' })),
      }),
    },
    (scan) => {
      const findings = checkLocalInstance(scan, { gameVersion: '1.20.1', loaderVersion: '0.15.11' })
      const dup = findings.find((f) => f.code === 'DUPLICATE_MOD')
      assert.ok(dup, '要报 DUPLICATE_MOD')
      assert.equal(dup.severity, 'blocker')
      assert.match(dup.hint ?? '', /a\.jar/)
      assert.match(dup.hint ?? '', /b\.jar/)
    },
  )
})

test('加载器不匹配：Fabric 实例里的 Forge 模组给 warning', () => {
  withInstances(
    {
      'forgeonly.jar': zipSync({
        'META-INF/mods.toml': strToU8(
          'modLoader = "javafml"\n[[mods]]\nmodId = "forgeonly"\nversion = "1.0.0"',
        ),
      }),
    },
    (scan) => {
      const findings = checkLocalInstance(scan, { gameVersion: '1.20.1', loaderVersion: '0.15.11' })
      const mismatch = findings.find((f) => f.code === 'LOADER_MISMATCH')
      assert.ok(mismatch, '要报 LOADER_MISMATCH')
      assert.equal(mismatch.severity, 'warning')
      assert.match(mismatch.message, /forge.*fabric/i)
    },
  )
})

test('breaks：声明互斥的两个模组都在实例里 → DECLARED_INCOMPATIBLE', () => {
  withInstances(
    {
      'a.jar': zipSync({
        'fabric.mod.json': strToU8(
          JSON.stringify({ id: 'a', version: '1.0.0', breaks: { b: '*' } }),
        ),
      }),
      'b.jar': zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'b', version: '1.0.0' })),
      }),
    },
    (scan) => {
      const findings = checkLocalInstance(scan, { gameVersion: '1.20.1', loaderVersion: '0.15.11' })
      const bad = findings.find((f) => f.code === 'DECLARED_INCOMPATIBLE')
      assert.ok(bad, '要报 DECLARED_INCOMPATIBLE')
      assert.equal(bad.severity, 'blocker')
      assert.match(bad.message, /a.*b/)
    },
  )
})

test('Forge 实例里的 Fabric 专用 jar：只报「会被忽略」，不算它缺 fabric-api（issue #17）', () => {
  withInstances(
    {
      // 纯 Fabric 模组，声明依赖 fabric-api
      'visuality.jar': zipSync({
        'fabric.mod.json': strToU8(
          JSON.stringify({ id: 'visuality', version: '0.7.1', depends: { 'fabric-api': '*' } }),
        ),
      }),
      // 正常的 Forge 模组
      'jei.jar': zipSync({
        'META-INF/mods.toml': strToU8(
          'modLoader = "javafml"\n[[mods]]\nmodId = "jei"\nversion = "15.0.0"',
        ),
      }),
    },
    (scan) => {
      const findings = checkLocalInstance(scan, { gameVersion: '1.20.1', loaderVersion: '47.2.0' })
      assert.equal(
        findings.some((f) => f.code === 'MISSING_DEPENDENCY'),
        false,
        '被加载器跳过的 jar，它声明的依赖不该算成缺失',
      )
      const mismatch = findings.find((f) => f.code === 'LOADER_MISMATCH')
      assert.ok(mismatch, '要提示这些 jar 会被忽略')
      assert.equal(mismatch.severity, 'warning')
      assert.match(mismatch.message, /fabric/)
      assert.deepEqual(mismatch.data?.mods, ['visuality'])
    },
    'forge',
  )
})

test('只有 jar-in-jar 的 -all jar 能提供前置（issue #16）', () => {
  const kff = zipSync({
    'META-INF/mods.toml': strToU8(
      ['modLoader="javafml"', '[[mods]]', 'modId="kotlinforforge"', 'version="4.12.0"'].join('\n'),
    ),
  })
  withInstances(
    {
      'kotlinforforge-4.12.0-all.jar': zipSync({
        'META-INF/jarjar/kffmod-4.12.0.jar': kff,
      }),
      'fzzy_config.jar': zipSync({
        'META-INF/mods.toml': strToU8(
          [
            'modLoader = "javafml"',
            '[[mods]]',
            'modId = "fzzy_config"',
            'version = "0.5.0"',
            '[[dependencies.fzzy_config]]',
            'modId = "kotlinforforge"',
            'mandatory = true',
          ].join('\n'),
        ),
      }),
    },
    (scan) => {
      const findings = checkLocalInstance(scan, { gameVersion: '1.20.1', loaderVersion: '47.2.0' })
      assert.equal(
        findings.some((f) => f.code === 'MISSING_DEPENDENCY'),
        false,
        'kotlinforforge 藏在 jar-in-jar 里，不该报缺前置',
      )
      const info = findings.find((f) => f.code === 'NESTED_ONLY_JAR')
      assert.ok(info, '要标注「只有 jar-in-jar 子模组」')
      assert.equal(info.severity, 'info')
      assert.match(info.hint ?? '', /kotlinforforge-4\.12\.0-all\.jar/)
    },
    'forge',
  )
})
