import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collect } from '../events/operation.js'
import { parseCrashReport } from './crash-report.js'
import { createDiagnose } from './index.js'

const REPORT = `---- Minecraft Crash Report ----
// Don't be sad, have a hug! <3

Time: 2026-11-09 12:00:00
Description: Rendering overlay

java.lang.NullPointerException: Cannot invoke "Object.toString()" because "x" is null

-- System Details --
Details:
\tMinecraft Version: 1.20.1
\tMinecraft Version ID: 1.20.1
\tOperating System: Windows 11 (amd64) version 10.0
\tJava Version: 17.0.8, Microsoft
\tLoaded Mods:
\t\t- sodium 0.5.11
\t\t- iris 1.7.6
\t\t- fabric-api 0.92.2
`

test('解析 Description / MC 版本 / 模组数', () => {
  const info = parseCrashReport(REPORT.split('\n'))
  assert.ok(info)
  assert.equal(info.description, 'Rendering overlay')
  assert.equal(info.gameVersion, '1.20.1')
  assert.equal(info.loadedMods, 3)
  assert.equal(info.descriptionLine, 5)
})

test('没有其它致命信号时，用 Description 兜底：判 crash 而不是 clean', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-crash-report-'))
  try {
    const path = join(dir, 'crash.txt')
    writeFileSync(path, REPORT)
    const r = await collect(createDiagnose({ logPath: path }))
    assert.equal(r.format, 'crash-report')
    assert.equal(r.verdict, 'crash')
    assert.equal(r.primary?.kind, 'graphics')
    assert.equal(r.crashReport?.description, 'Rendering overlay')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('已有 mixin 致命信号时，Description 不抢结论', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-crash-report-mixin-'))
  try {
    const path = join(dir, 'crash.txt')
    writeFileSync(
      path,
      REPORT.replace(
        'java.lang.NullPointerException: Cannot invoke "Object.toString()" because "x" is null',
        'org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException: mixin failed',
      ),
    )
    const r = await collect(createDiagnose({ logPath: path }))
    assert.equal(r.verdict, 'crash')
    assert.equal(r.primary?.kind, 'mixin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
