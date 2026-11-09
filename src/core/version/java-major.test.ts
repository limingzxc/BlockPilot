import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readJavaMajor } from './java-major.js'

test('读 javaVersion.majorVersion；缺字段/坏 JSON 返回 undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-java-major-'))
  try {
    const good = join(dir, 'good.json')
    writeFileSync(
      good,
      JSON.stringify({ javaVersion: { majorVersion: 25, component: 'java-runtime-epsilon' } }),
    )
    assert.equal(readJavaMajor(good), 25)

    const noField = join(dir, 'no-field.json')
    writeFileSync(noField, JSON.stringify({ id: '1.20.1' }))
    assert.equal(readJavaMajor(noField), undefined)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ nope')
    assert.equal(readJavaMajor(bad), undefined)

    assert.equal(readJavaMajor(join(dir, 'missing.json')), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
