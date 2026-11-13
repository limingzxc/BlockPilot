import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'
import type { ContentSource, VersionInfo } from '../content-source.js'
import { collect } from '../events/operation.js'
import type { HostProfile } from '../instance.js'
import { createPreflight } from './index.js'

const BASE_INDEX = {
  formatVersion: 1,
  game: 'minecraft',
  versionId: '1.0.0',
  name: 'P',
  dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.16.14' },
  files: [] as unknown[],
}

/** 离线 source：getVersions 返回给定行，没有 resolve 能力。 */
function source(rows: readonly VersionInfo[] = []): ContentSource {
  return {
    name: 'fake',
    getVersions: async () => rows,
  }
}

function writePack(dir: string, files: unknown[] = []): string {
  const path = join(dir, 'pack.mrpack')
  writeFileSync(
    path,
    zipSync({
      'modrinth.index.json': strToU8(JSON.stringify({ ...BASE_INDEX, files })),
    }),
  )
  return path
}

test('整合包预检也查内存：同一个 host 与目录预检结论一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-preflight-pack-'))
  try {
    const host: HostProfile = { os: 'windows', totalMemoryMiB: 2048, javaMajors: [17] }
    const report = await collect(
      createPreflight({ target: writePack(dir), source: source(), host }),
    )

    // 以前包分支只调 checkJava，同一个 host 下 `preflight <包>` 永远不报 LOW_MEMORY
    assert.ok(
      report.findings.some((f) => f.code === 'LOW_MEMORY'),
      '包预检必须和目录预检用同一套 checker',
    )
    assert.equal(report.verdict, 'warn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('整合包预检：解析到的元数据参与 mod 级检查，并计入 resolved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-preflight-pack-mods-'))
  try {
    const file = {
      path: 'mods/sodium.jar',
      hashes: { sha1: 'a'.repeat(40) },
      downloads: ['https://cdn.modrinth.com/data/AANobbMI/versions/abc123/sodium.jar'],
      fileSize: 1,
    }
    const row: VersionInfo = {
      projectId: 'AANobbMI',
      versionId: 'abc123',
      name: 'Sodium',
      gameVersions: ['1.20.1'],
      loaders: ['fabric'],
      dependencies: [],
      files: [],
    }

    const report = await collect(
      createPreflight({ target: writePack(dir, [file]), source: source([row]) }),
    )

    assert.equal(report.stats.mods, 1)
    assert.equal(report.stats.resolved, 1)
    assert.equal(report.stats.unresolved, 0)
    assert.equal(
      report.findings.some((f) => f.code === 'UNRESOLVED_MOD'),
      false,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
