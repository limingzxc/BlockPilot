/**
 * 安装 Fabric（含 Legacy Fabric）。
 *
 * 这里只负责 Fabric 特有的事：探测该用官方还是 Legacy、选 loader 版本、取 profile、
 * 发 `fabric.*` 事件。安装流程本身由 `profile.ts` 与 Quilt 共用。
 */
import { defaultSources } from '../download/sources.js'
import type { Mirror } from '../download/types.js'
import { Op } from '../events.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { detectFabricFlavor, fetchProfile, pickLoaderVersion } from '../sources/fabric.js'
import type { LoaderInstallResult } from './loader.js'
import type { ProfileEventCodes } from './profile.js'
import { installProfileLoader } from './profile.js'

export interface FabricSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** 不填则取最新 stable */
  readonly loaderVersion?: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
  /** 元数据与文件都走国内镜像（CLI 的 --china） */
  readonly mirror?: boolean
  /**
   * 强制使用 Legacy Fabric（1.6.x / 1.7.10 / 1.12.2）。
   * 缺省自动探测：官方 meta 有这个版本就用官方，否则退到 Legacy。
   */
  readonly legacy?: boolean
}

const FABRIC_EVENT_CODES: ProfileEventCodes = {
  noHash: 'fabric.no_hash',
  versionJson: 'fabric.version_json',
  marker: 'fabric.marker',
  natives: 'fabric.natives',
  ok: 'fabric.ok',
  cached: 'fabric.cached',
  failed: 'fabric.failed',
  progressId: 'fabric',
}

export function createFabricSetup(opts: FabricSetupOptions): Operation<LoaderInstallResult> {
  return defineOperation<LoaderInstallResult>('fabric-setup', async function* (signal) {
    // 先定用哪套 Fabric：1.6.4 / 1.7.10 / 1.12.2 只有 Legacy Fabric 有 loader
    const flavorProbe =
      opts.legacy === true
        ? ({ status: 'found', value: 'legacy' } as const)
        : await detectFabricFlavor(opts.gameVersion, signal, {
            ...(opts.mirror === true ? { mirror: true } : {}),
          })
    if (flavorProbe.status === 'unreachable') {
      // 连不上 ≠ 没有 Fabric。以前两者都落到 NO_FABRIC_FOR_VERSION，用户会去换版本
      yield Op.failed(
        'NETWORK_ERROR',
        `查 Fabric 版本列表失败：${flavorProbe.detail}`,
        '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
      )
      return
    }
    if (flavorProbe.status === 'absent') {
      yield Op.failed(
        'NO_FABRIC_FOR_VERSION',
        `Fabric（含 Legacy Fabric）都没有 Minecraft ${opts.gameVersion} 的 loader`,
        'Fabric 只覆盖 1.14+；1.6.x / 1.7.10 / 1.12.2 走 Legacy Fabric，其余版本只能装 Forge',
      )
      return
    }
    const flavor = flavorProbe.value
    if (flavor === 'legacy') {
      yield Op.log('warn', 'fabric.legacy', { gameVersion: opts.gameVersion })
    }

    const meta =
      flavor === 'legacy' ? { legacy: true } : opts.mirror === true ? { mirror: true } : {}
    const loaderVersion =
      opts.loaderVersion ?? (await pickLoaderVersion(opts.gameVersion, signal, meta))
    yield Op.log('info', 'fabric.loader', {
      gameVersion: opts.gameVersion,
      loaderVersion,
      flavor,
    })

    const profile = await fetchProfile(opts.gameVersion, loaderVersion, signal, meta)
    yield Op.log('info', 'fabric.profile', { id: profile.id, libraries: profile.libraries.length })

    const result = yield* installProfileLoader(
      {
        kind: 'fabric',
        layout: opts.layout,
        gameVersion: opts.gameVersion,
        loaderVersion,
        profile,
        sources: opts.sources ?? defaultSources(),
        concurrency: opts.concurrency ?? 4,
        codes: FABRIC_EVENT_CODES,
      },
      signal,
    )
    if (result === undefined) return

    yield Op.result(result)
    yield Op.done()
  })
}
