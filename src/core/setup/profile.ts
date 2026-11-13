/**
 * 「profile 型加载器」的安装实现：Fabric 与 Quilt 共用。
 *
 * 两者只差三件事——去哪查版本、去哪取 profile、事件码前缀。任务构建、sha1 探测、
 * 版本 JSON 落盘、实例标记、下载、原生库解压与结果汇总逐行相同，此前被复制成
 * 两份（`fabric.ts` 与 `quilt.ts`），其中 Quilt 那份没有任何测试。
 *
 * 这个 module 是 `LoaderInstall` 的内部 seam：两个 adapter 走同一份 implementation，
 * 对外仍然只有 `createLoaderInstall` 一个 interface。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/mirrors.js'
import type { DownloadTask, Mirror } from '../download/types.js'
import type { OpEvent } from '../events/index.js'
import { Op } from '../events/index.js'
import { writeInstanceIdentity } from '../instance/identity.js'
import { detectEnv } from '../launch/env.js'
import type { LaunchEnv } from '../launch-env.js'
import type { Layout } from '../layout.js'
import type { FabricProfile } from '../sources/fabric.js'
import { fetchMavenSha1, mavenCoordToPath } from '../sources/fabric.js'
import type { LoaderInstallResult } from './loader-types.js'
import { extractNativeJars } from './vanilla.js'

/** 事件码前缀不同，载荷形状相同，所以可以用两个字面量的联合。 */
export interface ProfileEventCodes {
  readonly noHash: 'fabric.no_hash' | 'quilt.no_hash'
  readonly versionJson: 'fabric.version_json' | 'quilt.version_json'
  readonly marker: 'fabric.marker' | 'quilt.marker'
  readonly natives: 'fabric.natives' | 'quilt.natives'
  readonly ok: 'fabric.ok' | 'quilt.ok'
  readonly cached: 'fabric.cached' | 'quilt.cached'
  readonly failed: 'fabric.failed' | 'quilt.failed'
  readonly progressId: 'fabric' | 'quilt'
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
 * profile 只给 maven 坐标和仓库地址，没有现成的 sha1。
 * 所以这里要为每个库额外取一次 `.sha1` 文件——宁可多一轮请求，
 * 也不放过没有哈希校验的文件（ADR-0005）。
 */
export async function buildProfileTasks(
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

export interface ProfileInstallInput {
  readonly kind: 'fabric' | 'quilt'
  readonly layout: Layout
  readonly gameVersion: string
  readonly loaderVersion: string
  readonly profile: FabricProfile
  readonly sources: readonly Mirror[]
  readonly concurrency: number
  readonly codes: ProfileEventCodes
}

/**
 * 安装一个 profile：库 → 版本 JSON → 实例标记 → 下载 → 原生库。
 *
 * 失败时已经 yield 过 `failed`，返回 undefined；调用方只需结束。
 */
export async function* installProfileLoader(
  input: ProfileInstallInput,
  signal: AbortSignal,
): AsyncGenerator<OpEvent<never>, LoaderInstallResult | undefined> {
  const { kind, layout, gameVersion, loaderVersion, profile, sources, concurrency, codes } = input
  const env = detectEnv()
  const { tasks, noHash, unreachable, nativeJars } = await buildProfileTasks(
    profile,
    layout,
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
    return undefined
  }
  if (noHash.length > 0) {
    yield Op.log('warn', codes.noHash, { count: noHash.length, libs: noHash.slice(0, 5) })
  }

  // 先把版本 JSON 写盘：即使下载失败，下次也能看到这个版本存在
  const jsonPath = layout.versionJson(profile.id)
  mkdirSync(dirname(jsonPath), { recursive: true })
  writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
  yield Op.log('info', codes.versionJson, { path: jsonPath })

  // 版本标记：让 preflight 知道这个实例是「1.21.1 + fabric 0.19.3」，
  // 而不是「目录里没有版本信息」
  const markerPath = writeInstanceIdentity(layout.gameDir, {
    gameVersion,
    loader: { kind, version: loaderVersion },
  })
  yield Op.log('info', codes.marker, { path: markerPath })

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
      ok: codes.ok,
      cached: codes.cached,
      failed: codes.failed,
      progressId: codes.progressId,
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
    nativesExtracted = extractNativeJars(nativeJars, layout.nativesDir(gameVersion), {
      arch: env.arch,
    })
    yield Op.log('info', codes.natives, { extracted: nativesExtracted })
  }

  return {
    versionId: profile.id,
    loaderVersion,
    versionJsonPath: jsonPath,
    failed,
    detail: {
      kind: 'profile',
      libraries: profile.libraries.length,
      downloaded,
      skipped,
      nativesExtracted,
    },
  }
}
