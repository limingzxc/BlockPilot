/**
 * 安装 Quilt loader。
 *
 * 与 Fabric 的流程几乎一样（profile JSON + maven 库 + 可选原生库），差别只有
 * 元数据地址与 loader 版本选择。所以这里只做 Quilt 特有的三段探测，
 * 安装流程交给 `profile.ts`——它同时服务 Fabric。
 */
import { defaultSources } from '../download/sources.js'
import type { Mirror } from '../download/types.js'
import { Op } from '../events.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { fetchQuiltProfile, listQuiltLoaders, pickQuiltLoaderVersion } from '../sources/quilt.js'
import type { LoaderInstallResult } from './loader.js'
import type { ProfileEventCodes } from './profile.js'
import { installProfileLoader } from './profile.js'

export interface QuiltSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** 不填则取版本号最大的 loader */
  readonly loaderVersion?: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
}

const QUILT_EVENT_CODES: ProfileEventCodes = {
  noHash: 'quilt.no_hash',
  versionJson: 'quilt.version_json',
  marker: 'quilt.marker',
  natives: 'quilt.natives',
  ok: 'quilt.ok',
  cached: 'quilt.cached',
  failed: 'quilt.failed',
  progressId: 'quilt',
}

export function createQuiltSetup(opts: QuiltSetupOptions): Operation<LoaderInstallResult> {
  return defineOperation<LoaderInstallResult>('quilt-setup', async function* (signal) {
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

    const result = yield* installProfileLoader(
      {
        kind: 'quilt',
        layout: opts.layout,
        gameVersion: opts.gameVersion,
        loaderVersion,
        profile,
        sources: opts.sources ?? defaultSources(),
        concurrency: opts.concurrency ?? 4,
        codes: QUILT_EVENT_CODES,
      },
      signal,
    )
    if (result === undefined) return

    yield Op.result(result)
    yield Op.done()
  })
}
