import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadTask, Mirror } from '../download/types.js'
import { Op } from '../events.js'
import { writeInstanceMarker } from '../instance/marker.js'
import type { LaunchEnv } from '../launch/env.js'
import { detectEnv } from '../launch/env.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import type { FabricProfile } from '../sources/fabric.js'
import {
  detectFabricFlavor,
  fetchMavenSha1,
  fetchProfile,
  mavenCoordToPath,
  pickLoaderVersion,
} from '../sources/fabric.js'
import { extractNativeJars } from './vanilla.js'

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

export interface FabricSetupResult {
  readonly versionId: string
  readonly loaderVersion: string
  readonly libraries: number
  readonly downloaded: number
  readonly skipped: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly noHash: readonly string[]
  readonly nativesExtracted: number
  readonly versionJsonPath: string
}

interface BuiltTasks {
  readonly tasks: readonly DownloadTask[]
  /** 拿不到 sha1 的库：按 ADR-0005 不允许下载 */
  readonly noHash: readonly string[]
  /** sha1 探测没连上的库（不是「没有哈希」）：调用方要报网络错误 */
  readonly unreachable: readonly string[]
  /** 原生库 jar 的落盘路径，下载完要解压到 natives/<mc> */
  readonly nativeJars: readonly string[]
}

/**
 * Fabric 的 profile 只给 maven 坐标和仓库地址，没有现成的 sha1。
 * 所以这里要为每个库额外取一次 `.sha1` 文件——宁可多一轮请求，
 * 也不放过没有哈希校验的文件（ADR-0005）。
 */
export async function buildFabricTasks(
  profile: FabricProfile,
  layout: Layout,
  signal?: AbortSignal,
  /** sha1 探测与下载共用同一套镜像规则 */
  sources: readonly Mirror[] = defaultSources(),
  env: LaunchEnv = detectEnv(),
): Promise<BuiltTasks> {
  const tasks: DownloadTask[] = []
  const noHash: string[] = []
  const unreachable: string[] = []
  const nativeJars: string[] = []

  for (const lib of profile.libraries) {
    /**
     * 老版本的原生库：profile 里只写裸坐标 + `natives` map，
     * 而裸坐标在 maven 上**不存在**（1.6.4 的 lwjgl-platform:2.9.4+legacyfabric.17
     * 只有带 `-natives-windows` 的 classifier）。照裸坐标去下必然 404，
     * 表现就是「进游戏 UnsatisfiedLinkError: no lwjgl」。
     */
    const classifier = lib.natives?.[env.os]
    if (classifier !== undefined) {
      const nativePath = mavenCoordToPath(`${lib.name}:${classifier}`)
      if (nativePath !== null && lib.url !== undefined) {
        const dest = join(layout.libraries, ...nativePath.split('/'))
        if (!existsSync(dest)) {
          const base = lib.url.replace(/\/+$/, '')
          const url = `${base}/${nativePath}`
          const sha1 = await fetchMavenSha1(url, {
            ...(signal === undefined ? {} : { signal }),
            candidates: sources
              .map((src) => src.rewrite(new URL(`${url}.sha1`)))
              .filter((u): u is string => u !== null),
          })
          if (sha1.status === 'unreachable') unreachable.push(url)
          else if (sha1.status === 'absent') noHash.push(`${lib.name}:${classifier}`)
          else {
            tasks.push({
              url,
              fileName: basename(nativePath),
              destPath: dest,
              expectedSize: 0,
              hashes: { sha1: sha1.value },
            })
          }
        }
        nativeJars.push(dest)
      }
      continue
    }

    const artifact = lib.downloads?.artifact
    if (artifact !== undefined) {
      tasks.push({
        url: artifact.url,
        fileName: basename(artifact.path),
        destPath: join(layout.libraries, ...artifact.path.split('/')),
        expectedSize: artifact.size,
        hashes: { sha1: artifact.sha1 },
      })
      continue
    }

    const path = mavenCoordToPath(lib.name)
    if (path === null || lib.url === undefined) {
      noHash.push(`${lib.name}（无法解析 maven 坐标）`)
      continue
    }
    const destPath = join(layout.libraries, ...path.split('/'))
    // 已经装过的库不再探测 sha1：断网/镜像缺 .sha1 时不该把「已存在」说成失败
    if (existsSync(destPath)) continue

    const base = lib.url.replace(/\/+$/, '')
    const url = `${base}/${path}`
    const sha1Url = new URL(`${url}.sha1`)
    const sha1Candidates = sources
      .map((src) => src.rewrite(sha1Url))
      .filter((u): u is string => u !== null)
    const sha1 = await fetchMavenSha1(url, {
      ...(signal === undefined ? {} : { signal }),
      candidates: sha1Candidates,
    })
    if (sha1.status === 'unreachable') {
      unreachable.push(url)
      continue
    }
    if (sha1.status === 'absent') {
      noHash.push(lib.name)
      continue
    }
    tasks.push({
      url,
      fileName: basename(path),
      destPath,
      // maven 不给 size，跳过大小检查，只靠哈希
      expectedSize: 0,
      hashes: { sha1: sha1.value },
    })
  }

  return { tasks, noHash, unreachable, nativeJars }
}

export function createFabricSetup(opts: FabricSetupOptions): Operation<FabricSetupResult> {
  return defineOperation<FabricSetupResult>('fabric-setup', async function* (signal) {
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
      // 探测 sha1 时断网：这不是「这些库没有哈希」，不能继续装出一个缺库的实例
      yield Op.failed(
        'NETWORK_ERROR',
        `取不到 ${unreachable.length} 个库的 sha1（第一个：${unreachable[0] ?? ''}）`,
        '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
      )
      return
    }
    if (noHash.length > 0) {
      yield Op.log('warn', 'fabric.no_hash', { count: noHash.length, libs: noHash.slice(0, 5) })
    }

    // 先把版本 JSON 写盘：即使下载失败，下次也能看到这个版本存在
    const jsonPath = opts.layout.versionJson(profile.id)
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
    yield Op.log('info', 'fabric.version_json', { path: jsonPath })

    // 版本标记：让 preflight 知道这个实例是「1.21.1 + fabric 0.19.3」，
    // 而不是「目录里没有版本信息」
    const markerPath = writeInstanceMarker(opts.layout.gameDir, {
      gameVersion: opts.gameVersion,
      loader: { kind: 'fabric', version: loaderVersion },
    })
    yield Op.log('info', 'fabric.marker', { path: markerPath })

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
        ok: 'fabric.ok',
        cached: 'fabric.cached',
        failed: 'fabric.failed',
        progressId: 'fabric',
      },
    })

    // 拿不到 sha1 的库按 ADR-0005 不下载，但要算失败：静默跳过会装出一个
    // 看起来成功、实际上缺 loader 的实例
    const failed = [
      ...batchFailed,
      ...noHash.map((name) => ({
        fileName: name,
        error: '拿不到 sha1，按 ADR-0005 不下载（换网络或去掉 --china 重试）',
      })),
    ]

    /**
     * 老版本的原生库要解压到 natives/<mc 版本>。
     *
     * 加载器版本 id（fabric-loader-0.20.1-1.6.4）和原版 id（1.6.4）不是一回事：
     * 启动参数里的 `java.library.path` 指向**原版**那个目录，所以这里把 profile 的 id
     * 换成 gameVersion 再解压，否则 DLL 解到了没人看的地方。
     */
    let nativesExtracted = 0
    if (nativeJars.length > 0) {
      nativesExtracted = extractNativeJars(nativeJars, opts.layout.nativesDir(opts.gameVersion))
      yield Op.log('info', 'fabric.natives', { extracted: nativesExtracted })
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
