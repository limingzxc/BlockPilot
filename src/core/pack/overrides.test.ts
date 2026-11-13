import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { countOverridesMods } from './overrides.js'

test('overrides/mods 里的 jar 单独计数（issue #13）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-pack-overrides-'))
  try {
    const zipPath = join(dir, 'count.zip')
    writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8('{}'),
        'overrides/mods/aaa.jar': strToU8('x'),
        'overrides/mods/bbb.JAR': strToU8('x'),
        'overrides/mods/readme.txt': strToU8('x'),
        'overrides/config/x.toml': strToU8('x'),
        'client-overrides/mods/ccc.jar': strToU8('x'),
        'other/mods/ignored.jar': strToU8('x'),
      }),
    )
    assert.equal(countOverridesMods(zipPath), 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
