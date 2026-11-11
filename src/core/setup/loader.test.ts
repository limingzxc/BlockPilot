import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Op } from '../events.js'
import { resolveLayout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import type { LoaderInstallOptions, LoaderInstallResult } from './loader.js'
import { createLoaderInstall, loaderNeedsJava, SUPPORTED_LOADERS } from './loader.js'

function fakeResult(kind: 'profile' | 'installer'): LoaderInstallResult {
  return {
    versionId: `fake-${kind}`,
    loaderVersion: '1.2.3',
    versionJsonPath: `/fake/${kind}.json`,
    failed: [],
    detail:
      kind === 'profile'
        ? { kind: 'profile', libraries: 0, downloaded: 0, skipped: 0, nativesExtracted: 0 }
        : { kind: 'installer', installerRan: false },
  }
}

function recordingStep(
  kind: 'profile' | 'installer',
  seen: LoaderInstallOptions[],
): (options: LoaderInstallOptions) => Operation<LoaderInstallResult> {
  return (options) => {
    seen.push(options)
    return defineOperation<LoaderInstallResult>(`fake-${kind}`, async function* () {
      yield Op.result(fakeResult(kind))
      yield Op.done()
    })
  }
}

async function run(op: Operation<LoaderInstallResult>): Promise<{
  failed?: { code: string; message: string }
  result?: LoaderInstallResult
}> {
  const out: { failed?: { code: string; message: string }; result?: LoaderInstallResult } = {}
  for await (const ev of op.run(new AbortController().signal)) {
    if (ev.type === 'failed') out.failed = { code: ev.code, message: ev.message }
    if (ev.type === 'result') out.result = ev.value
  }
  return out
}

function baseOptions(kind: LoaderInstallOptions['kind']) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-loader-'))
  return {
    dir,
    options: {
      kind,
      layout: resolveLayout(dir, 'default'),
      gameVersion: '1.20.1',
    } satisfies LoaderInstallOptions,
  }
}

test('vanilla 不能自动安装：UNSUPPORTED_LOADER', async () => {
  const { dir, options } = baseOptions('vanilla')
  try {
    const out = await run(createLoaderInstall(options))
    assert.equal(out.failed?.code, 'UNSUPPORTED_LOADER')
    assert.equal(out.result, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Fabric / Quilt 走 profile 那一路，并把 kind 传下去', async () => {
  for (const kind of ['fabric', 'quilt'] as const) {
    const { dir, options } = baseOptions(kind)
    const seen: LoaderInstallOptions[] = []
    try {
      const out = await run(
        createLoaderInstall({
          ...options,
          deps: {
            profile: recordingStep('profile', seen),
            installer: recordingStep('installer', []),
          },
        }),
      )
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.kind, kind)
      assert.equal(out.result?.detail.kind, 'profile')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('Forge / NeoForge 走 installer 那一路，并把 kind 传下去', async () => {
  for (const kind of ['forge', 'neoforge'] as const) {
    const { dir, options } = baseOptions(kind)
    const seen: LoaderInstallOptions[] = []
    try {
      const out = await run(
        createLoaderInstall({
          ...options,
          java: 'java',
          deps: {
            profile: recordingStep('profile', []),
            installer: recordingStep('installer', seen),
          },
        }),
      )
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.kind, kind)
      assert.equal(out.result?.detail.kind, 'installer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('installer 型加载器缺 java：NEED_JAVA，且不进入安装步骤', async () => {
  const { dir, options } = baseOptions('forge')
  const seen: LoaderInstallOptions[] = []
  try {
    const out = await run(
      createLoaderInstall({
        ...options,
        deps: { installer: recordingStep('installer', seen) },
      }),
    )
    assert.equal(out.failed?.code, 'NEED_JAVA')
    assert.equal(seen.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('能力表：只有 Forge / NeoForge 需要 Java，deploy 名单由表派生', () => {
  assert.equal(loaderNeedsJava('vanilla'), false)
  assert.equal(loaderNeedsJava('fabric'), false)
  assert.equal(loaderNeedsJava('quilt'), false)
  assert.equal(loaderNeedsJava('forge'), true)
  assert.equal(loaderNeedsJava('neoforge'), true)

  assert.deepEqual([...SUPPORTED_LOADERS].sort(), ['fabric', 'forge', 'neoforge', 'quilt'])
})
