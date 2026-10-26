/**
 * deploy 的 interface 级测试（架构评审候选 5）。
 *
 * 此前全链路最复杂的编排（5 步、失败中断、CF 拦截、自检）删掉没有任何测试会红——
 * 所有测试都绕过 Operation interface 直插内部纯函数。这里改为穿过 interface：
 * run() → 断言事件序列与 result，用 DeployDeps 注入假步骤，全程离线。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { collect, defineOperation } from './operation.js'
import { Op } from './events.js'
import type { OpEvent } from './events.js'
import { createDeploy } from './deploy.js'
import type { DeployResult } from './deploy.js'
import { resolveLayout } from './layout.js'

function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-deploy-'))
  mkdirSync(dir, { recursive: true })
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** 造一个最小的 mrpack：依赖齐、files 为空（整合包文件下载走空批，不碰网络） */
function writeMrpack(
  dir: string,
  deps: Record<string, string> = { minecraft: '1.20.1', 'fabric-loader': '0.16.14' },
): string {
  const path = join(dir, 'pack.mrpack')
  writeFileSync(
    path,
    zipSync({
      'modrinth.index.json': strToU8(
        JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: '1.0.0',
          name: 'Test Pack',
          files: [],
          dependencies: deps,
        }),
      ),
    }),
  )
  return path
}

/** 假的原版步骤：发一条 log 再产出 result */
const fakeVanilla = (): ReturnType<typeof defineOperation<unknown>> =>
  defineOperation<unknown>('fake-vanilla', async function* () {
    yield Op.log('info', 'fake.vanilla.log')
    yield Op.result({ ok: true })
    yield Op.done()
  })

const fakeLoader = (versionId: string) =>
  defineOperation<{ versionId: string }>('fake-loader', async function* () {
    yield Op.log('info', 'fake.loader.log')
    yield Op.result({ versionId })
    yield Op.done()
  })

function collectEvents(
  gen: AsyncIterable<OpEvent<DeployResult>>,
): Promise<{ events: OpEvent<DeployResult>[]; result?: DeployResult; failed?: { code: string } }> {
  return (async () => {
    const events: OpEvent<DeployResult>[] = []
    let result: DeployResult | undefined
    let failed: { code: string } | undefined
    for await (const ev of gen) {
      events.push(ev)
      if (ev.type === 'result') result = ev.value
      if (ev.type === 'failed') failed = { code: ev.code }
    }
    return { events, result, failed }
  })()
}

test('完整编排：结果里的 playableVersionId 来自 loader 的契约', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    const op = createDeploy({
      packPath: writeMrpack(dir),
      layout,
      deps: {
        vanilla: () => fakeVanilla(),
        loader: () => fakeLoader('fabric-loader-9.9.9-1.20.1'),
      },
    })
    const result = await collect(op)
    assert.equal(result.playableVersionId, 'fabric-loader-9.9.9-1.20.1')
    assert.equal(result.gameVersion, '1.20.1')
    assert.equal(result.loaderKind, 'fabric')
    assert.equal(result.mods, 0)
    assert.equal(result.failed.length, 0)
  })
})

test('事件契约：子步骤的 log 转发，result 与 done 不转发', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    const op = createDeploy({
      packPath: writeMrpack(dir),
      layout,
      deps: { vanilla: () => fakeVanilla(), loader: () => fakeLoader('v1') },
    })
    const { events, result } = await collectEvents(op.run(new AbortController().signal))

    const codes = events.filter((e) => e.type === 'log').map((e) => (e as { code: string }).code)
    assert.ok(codes.includes('fake.vanilla.log'), '子步骤的 log 应转发')
    assert.ok(codes.includes('fake.loader.log'))
    assert.ok(codes.includes('deploy.step'))

    // 整个流里只能有一个 result（deploy 自己的），子步骤的 result 被吞掉
    const results = events.filter((e) => e.type === 'result')
    assert.equal(results.length, 1)
    assert.equal(result?.playableVersionId, 'v1')

    // done 不转发：全流只有 deploy 自己那一个，且在最后
    assert.equal(events.filter((e) => e.type === 'done').length, 1)
    assert.equal(events[events.length - 1]?.type, 'done')
  })
})

test('原版步骤失败：failed 原样转发并中止，不再跑加载器', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    let loaderCalled = false
    const op = createDeploy({
      packPath: writeMrpack(dir),
      layout,
      deps: {
        vanilla: () =>
          defineOperation<unknown>('bad-vanilla', async function* () {
            yield Op.failed('DISK_FULL', '磁盘满了')
          }),
        loader: () => {
          loaderCalled = true
          return fakeLoader('v1')
        },
      },
    })
    const { failed, result, events } = await collectEvents(op.run(new AbortController().signal))
    assert.equal(failed?.code, 'DISK_FULL')
    assert.equal(result, undefined)
    assert.equal(loaderCalled, false, '原版失败后不应继续')
    const steps = events.filter(
      (e) => e.type === 'log' && (e as { code: string }).code === 'deploy.step',
    )
    assert.equal(steps.length, 1, '原版失败后不应出现后续 step 标记')
  })
})

test('加载器没产出 result：报 LOADER_FAILED', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    const op = createDeploy({
      packPath: writeMrpack(dir),
      layout,
      deps: {
        vanilla: () => fakeVanilla(),
        loader: () =>
          defineOperation<{ versionId: string }>('silent-loader', async function* () {
            yield Op.log('info', 'silent')
            // 故意不产出 result
          }),
      },
    })
    const { failed } = await collectEvents(op.run(new AbortController().signal))
    assert.equal(failed?.code, 'LOADER_FAILED')
  })
})

test('CurseForge 包：明确拒绝而不是含糊的 BAD_MODPACK', async () => {
  await withTemp(async (dir) => {
    const packPath = join(dir, 'cf.zip')
    writeFileSync(
      packPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            manifestType: 'minecraftModpack',
            manifestVersion: 1,
            name: 'CF Pack',
            minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.3.0', primary: true }] },
            files: [],
          }),
        ),
      }),
    )
    const op = createDeploy({ packPath, layout: resolveLayout(dir, 'test') })
    const { failed } = await collectEvents(op.run(new AbortController().signal))
    assert.equal(failed?.code, 'CF_API_REQUIRED')
  })
})

test('不支持的加载器：UNSUPPORTED_LOADER', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    const op = createDeploy({
      packPath: writeMrpack(dir, { minecraft: '1.20.1', 'quilt-loader': '0.23.0' }),
      layout,
    })
    const { failed } = await collectEvents(op.run(new AbortController().signal))
    assert.equal(failed?.code, 'UNSUPPORTED_LOADER')
  })
})

test('Forge 包缺 java：NEED_JAVA', async () => {
  await withTemp(async (dir) => {
    const layout = resolveLayout(dir, 'test')
    const op = createDeploy({
      packPath: writeMrpack(dir, { minecraft: '1.20.1', forge: '47.3.0' }),
      layout,
      deps: { vanilla: () => fakeVanilla() },
    })
    const { failed } = await collectEvents(op.run(new AbortController().signal))
    assert.equal(failed?.code, 'NEED_JAVA')
  })
})
