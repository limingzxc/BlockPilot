import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { scanInstanceDir } from '../instance/scan.js'
import { checkLocalInstance } from './local.js'

function withInstances(
  jars: Record<string, Uint8Array | string>,
  fn: (scan: ReturnType<typeof scanInstanceDir>) => void,
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
        fallbackLoader: { kind: 'fabric', version: '0.15.11' },
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
