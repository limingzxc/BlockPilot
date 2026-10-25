import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { AsyncQueue, runPool } from '../download/queue.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadSource, DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import {
  fetchMavenSha1,
  fetchProfile,
  mavenCoordToPath,
  pickLoaderVersion,
} from '../sources/fabric.js'
import type { FabricProfile } from '../sources/fabric.js'

export interface FabricSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** 不填则取最新 stable */
  readonly loaderVersion?: string
  readonly sources?: readonly DownloadSource[]
  readonly concurrency?: number
}

export interface FabricSetupResult {
  readonly versionId: string
  readonly loaderVersion: string
  readonly libraries: number
  readonly downloaded: number
  readonly skipped: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly noHash: readonly string[]
  readonly versionJsonPath: string
}

interface BuiltTasks {
  readonly tasks: readonly DownloadTask[]
  /** 拿不到 sha1 的库：按 ADR-0005 不允许下载 */
  readonly noHash: readonly string[]
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
  sources: readonly DownloadSource[] = defaultSources(),
): Promise<BuiltTasks> {
  const tasks: DownloadTask[] = []
  const noHash: string[] = []

  for (const lib of profile.libraries) {
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
    const base = lib.url.replace(/\/+$/, '')
    const url = `${base}/${path}`
    const sha1Url = new URL(`${url}.sha1`)
    const sha1Candidates = sources
      .map((src) => src.rewrite(sha1Url))
      .filter((u): u is string => u !== null)
    const sha1 = await fetchMavenSha1(url, { ...(signal === undefined ? {} : { signal }), candidates: sha1Candidates })
    if (sha1 === null) {
      noHash.push(lib.name)
      continue
    }
    tasks.push({
      url,
      fileName: basename(path),
      destPath: join(layout.libraries, ...path.split('/')),
      // maven 不给 size，跳过大小检查，只靠哈希
      expectedSize: 0,
      hashes: { sha1 },
    })
  }

  return { tasks, noHash }
}

export function createFabricSetup(opts: FabricSetupOptions): Operation<FabricSetupResult> {
  return defineOperation<FabricSetupResult>('fabric-setup', async function* (signal) {
    const loaderVersion =
      opts.loaderVersion ?? (await pickLoaderVersion(opts.gameVersion, signal))
    yield Op.log('info', 'fabric.loader', { gameVersion: opts.gameVersion, loaderVersion })

    const profile = await fetchProfile(opts.gameVersion, loaderVersion, signal)
    yield Op.log('info', 'fabric.profile', { id: profile.id, libraries: profile.libraries.length })

    const sources = opts.sources ?? defaultSources()
    const { tasks, noHash } = await buildFabricTasks(profile, opts.layout, signal, sources)
    if (noHash.length > 0) {
      yield Op.log('warn', 'fabric.no_hash', { count: noHash.length, libs: noHash.slice(0, 5) })
    }

    // 先把版本 JSON 写盘：即使下载失败，下次也能看到这个版本存在
    const jsonPath = opts.layout.versionJson(profile.id)
    mkdirSync(dirname(jsonPath), { recursive: true })
    writeFileSync(jsonPath, JSON.stringify(profile, null, 2))
    yield Op.log('info', 'fabric.version_json', { path: jsonPath })

    const concurrency = opts.concurrency ?? 4
    const queue = new AsyncQueue<OpEvent<never>>()
    const failed: { fileName: string; error: string }[] = []
    let done = 0
    let downloaded = 0
    let skipped = 0

    const runner = runPool(tasks, concurrency, async (task) => {
      if (signal.aborted) return
      try {
        const outcome = await downloadOne(task, sources, signal)
        if (outcome.skipped) skipped += 1
        else downloaded += 1
        queue.push(
          Op.log('info', outcome.skipped ? 'fabric.cached' : 'fabric.ok', {
            file: task.fileName,
            source: outcome.source,
          }),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ fileName: task.fileName, error: message })
        queue.push(Op.log('error', 'fabric.failed', { file: task.fileName, error: message }))
      } finally {
        done += 1
        queue.push(Op.progress('fabric', done, tasks.length, task.fileName))
      }
    }).finally(() => queue.close())

    for await (const ev of queue.drain()) yield ev
    await runner

    yield Op.result({
      versionId: profile.id,
      loaderVersion,
      libraries: profile.libraries.length,
      downloaded,
      skipped,
      failed,
      noHash,
      versionJsonPath: jsonPath,
    })
    yield Op.done()
  })
}
