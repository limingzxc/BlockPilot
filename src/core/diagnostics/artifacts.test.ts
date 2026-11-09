import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { findCrashArtifacts } from './artifacts.js'

test('hs_err、crash-report、会话日志按修改时间排序，debug.log 被排除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-artifacts-'))
  try {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    mkdirSync(join(dir, 'crash-reports'), { recursive: true })

    const hs = join(dir, 'hs_err_pid123.log')
    const crash = join(dir, 'crash-reports', 'crash-2026-11-09_12.00.00-client.txt')
    const latest = join(dir, 'logs', 'latest.log')
    const debug = join(dir, 'logs', 'debug.log')
    for (const p of [hs, crash, latest, debug]) writeFileSync(p, 'x')

    // 明确的时间顺序：latest < crash < hs_err
    utimesSync(latest, new Date(1000), new Date(1000))
    utimesSync(debug, new Date(9000), new Date(9000))
    utimesSync(crash, new Date(2000), new Date(2000))
    utimesSync(hs, new Date(3000), new Date(3000))

    const found = findCrashArtifacts(dir)
    assert.deepEqual(
      found.map((a) => a.kind),
      ['hs-err', 'crash-report', 'log'],
    )
    assert.equal(found[0]?.path, hs)
    assert.equal(found[2]?.path, latest)
    assert.equal(
      found.some((a) => a.path.endsWith('debug.log')),
      false,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('什么都没有时返回空数组，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-artifacts-empty-'))
  try {
    assert.deepEqual(findCrashArtifacts(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
