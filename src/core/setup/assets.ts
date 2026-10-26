import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadSource, DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import { fetchVersionJson } from '../version/fetch.js'

/** assets/indexes/<id>.json */
export interface AssetIndex {
  readonly objects: Readonly<Record<string, { readonly hash: string; readonly size: number }>>
}

export interface AssetsSetupOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources?: readonly DownloadSource[]
  readonly concurrency?: number
  readonly dryRun?: boolean
  /** 每多少个文件报一次进度。3598 个文件逐个报会刷屏 */
  readonly progressEvery?: number
  /** 走 BMCLAPI 拉 version json */
  readonly mirror?: boolean
}

export interface AssetsSetupResult {
  readonly indexId: string
  readonly total: number
  readonly unique: number
  readonly downloaded: number
  readonly skipped: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly totalBytes: number
}

/**
 * 把 asset index 展开成下载任务。
 *
 * 注意去重：index 里不同的逻辑路径可能指向同一个 hash（同一份音效被多个 key 引用）。
 * 按 hash 去重能把 3598 个 key 压到实际不重复的对象数。
 */
export function buildAssetTasks(index: AssetIndex, layout: Layout): DownloadTask[] {
  const seen = new Set<string>()
  const tasks: DownloadTask[] = []

  for (const obj of Object.values(index.objects)) {
    if (seen.has(obj.hash)) continue
    seen.add(obj.hash)
    const prefix = obj.hash.slice(0, 2)
    tasks.push({
      // BMCLAPI 的规则会把 host 换成 bmclapi2.bangbang93.com 并加 /assets 前缀
      url: `https://resources.download.minecraft.net/${prefix}/${obj.hash}`,
      fileName: obj.hash,
      destPath: join(layout.assets, 'objects', prefix, obj.hash),
      expectedSize: obj.size,
      hashes: { sha1: obj.hash },
    })
  }
  return tasks
}

export function readAssetIndex(path: string): AssetIndex {
  if (!existsSync(path)) {
    throw new Error(`找不到 asset index：${path}（先跑 setup）`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as AssetIndex
}

export function createAssetsSetup(opts: AssetsSetupOptions): Operation<AssetsSetupResult> {
  return defineOperation<AssetsSetupResult>('assets-setup', async function* (signal) {
    const version = await fetchVersionJson(opts.versionId, {
      ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
      signal,
    })
    const indexId = version.assetIndex?.id ?? version.assets
    const indexPath = opts.layout.assetIndex(indexId)
    const index = readAssetIndex(indexPath)
    const tasks = buildAssetTasks(index, opts.layout)
    const totalBytes = tasks.reduce((s, t) => s + t.expectedSize, 0)
    const keyCount = Object.keys(index.objects).length

    yield Op.log('info', 'assets.tasks', {
      index: indexId,
      keys: keyCount,
      unique: tasks.length,
      totalBytes,
    })

    if (opts.dryRun === true) {
      yield Op.result({
        indexId,
        total: keyCount,
        unique: tasks.length,
        downloaded: 0,
        skipped: 0,
        failed: [],
        totalBytes,
      })
      yield Op.done()
      return
    }

    const sources = opts.sources ?? defaultSources()
    // 三千多个小文件，瓶颈是请求往返而不是带宽，并发要比默认高
    const concurrency = opts.concurrency ?? 8
    const reportEvery = opts.progressEvery ?? 50

    // 3598 个文件逐条报会把 CLI 刷爆：不逐文件发 log，进度按批次报
    const { downloaded, skipped, bytes, failed } = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: { ok: 'assets.ok', cached: 'assets.cached', failed: 'assets.failed', progressId: 'assets' },
      logPerFile: false,
      progressEvery: reportEvery,
    })

    yield Op.result({
      indexId,
      total: keyCount,
      unique: tasks.length,
      downloaded,
      skipped,
      failed,
      totalBytes: bytes,
    })
    yield Op.done()
  })
}
