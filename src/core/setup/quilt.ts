/**
 * 安装 Quilt loader。
 *
 * 与 Fabric 的流程几乎一样（profile JSON + maven 库 + 可选原生库），差别只有
 * 元数据地址与 loader 版本选择。所以这里复用 `buildFabricTasks`——它只依赖
 * profile 的 `libraries` 形状，不关心是 Fabric 还是 Quilt。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/sources.js'
import type { Mirror } from '../download/types.js'
import { Op } from '../events.js'
import { writeInstanceMarker } from '../instance/marker.js'
import { detectEnv } from '../launch/env.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { fetchQuiltProfile, listQuiltLoaders, pickQuiltLoaderVersion } from '../sources/quilt.js'
import type { FabricSetupResult } from './fabric.js'
import { buildFabricTasks } from './fabric.js'
import { extractNativeJars } from './vanilla.js'

export interface QuiltSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** 不填则取版本号最大的 loader */
  readonly loaderVersion?: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
}

export type QuiltSetupResult = FabricSetupResult

export function createQuiltSetup(opts: QuiltSetupOptions): Operation<QuiltSetupResult> {
  return defineOperation<QuiltSetupResult>('quilt-setup', async function* (signal) {
    let loaderVersion = opts.loaderVersion
    if (loaderVersion === undefined) {
      const probe = await listQuiltLoaders(opts.gameVersion, signal)
      if (probe.status === 'unreachable') {
        yield Op.failed(
          'NETWORK_ERROR',
          `查 Quilt 版本列表失败：${probe.detail}`,
          '检查网络；也可以用 --loader 显式指定版本',
        )
        return
      }
      if (probe.status === 'absent') {
        yield Op.failed(
          'NO_QUILT_FOR_VERSION',
          `Quilt 没有 Minecraft ${opts.gameVersion} 的 loader`,
          '用 --loader 指定版本，或换 Fabric / Forge',
        )
        return
      }
      loaderVersion = pickQuiltLoaderVersion(probe.value)
      if (loaderVersion === undefined) {
        yield Op.failed(
          'NO_QUILT_FOR_VERSION',
          `Quilt 没有 Minecraft ${opts.gameVersion} 的 loader`,
        )
        return
      }
    }

    yield Op.log('info', 'quilt.loader', { gameVersion: opts.gameVersion, loaderVersion })

    const profileProbe = await fetchQuiltProfile(opts.gameVersion, loaderVersion, signal)
    if (profileProbe.status === 'unreachable') {
      yield Op.failed(
        'NETWORK_ERROR',
        `取 Quilt profile 失败：${profileProbe.detail}`,
        '检查网络；也可以用 --loader 换一个版本',
      )
      return
    }
    if (profileProbe.status === 'absent') {
      yield Op.failed(
        'NO_QUILT_PROFILE',
        `Quilt ${loaderVersion} 没有 ${opts.gameVersion} 的 profile${profileProbe.detail === undefined ? '' : `（${profileProbe.detail}）`}`,
      )
      return
    }
    const profile = profileProbe.value
    yield Op.log('info', 'quilt.profile', { id: profile.id, libraries: profile.libraries.length })

    const sources = opts.sources ?? defaultSources()
    const env = detectEnv()
    const { tasks, noHash, unreachable, nativeJars } = await buildFabricTasks(
      profile,
      opts.layout,
      signal,
      sources,
      env,
    )
    if (unreachable.length > 0) {
      yield Op.failed(
        'NETWORK_ERROR',
        `取不到 ${unreachable.length} 个库的 sha1（第一个：${unreachable[0] ?? ''}）`,
        '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
      )
      return
    }
    if (noHash.length > 0) {
      yield Op.log('warn', 'quilt.no_hash', { count: noHash.length, libs: noHash.slice(0, 5) })
    }

    const jsonPath = opts.layout.versionJson(profile.id)
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
    yield Op.log('info', 'quilt.version_json', { path: jsonPath })

    const markerPath = writeInstanceMarker(opts.layout.gameDir, {
      gameVersion: opts.gameVersion,
      loader: { kind: 'quilt', version: loaderVersion },
    })
    yield Op.log('info', 'quilt.marker', { path: markerPath })

    const concurrency = opts.concurrency ?? 4
    const {
      downloaded,
      skipped,
      failed: batchFailed,
    } = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: {
        ok: 'quilt.ok',
        cached: 'quilt.cached',
        failed: 'quilt.failed',
        progressId: 'quilt',
      },
    })

    const failed = [
      ...batchFailed,
      ...noHash.map((name) => ({
        fileName: name,
        error: '拿不到 sha1，按 ADR-0005 不下载（换网络或去掉 --china 重试）',
      })),
    ]

    let nativesExtracted = 0
    if (nativeJars.length > 0) {
      nativesExtracted = extractNativeJars(nativeJars, opts.layout.nativesDir(opts.gameVersion), {
        arch: env.arch,
      })
      yield Op.log('info', 'quilt.natives', { extracted: nativesExtracted })
    }

    yield Op.result({
      versionId: profile.id,
      loaderVersion,
      libraries: profile.libraries.length,
      nativesExtracted,
      downloaded,
      skipped,
      failed,
      noHash,
      versionJsonPath: jsonPath,
    })
    yield Op.done()
  })
}
