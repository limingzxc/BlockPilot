import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadTask, Mirror } from '../download/types.js'
import { Op } from '../events.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { fetchVersionJson } from '../version/fetch.js'

/** assets/indexes/<id>.json */
export interface AssetIndex {
  readonly objects: Readonly<Record<string, { readonly hash: string; readonly size: number }>>
}

export interface AssetsSetupOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources?: readonly Mirror[]
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

export interface AssetsProbe {
  /** index 里去重后的对象数 */
  readonly total: number
  readonly sampled: number
  readonly present: number
  /** 抽样里缺失的那几个 hash，用于打印证据 */
  readonly missingSample: readonly string[]
}

/**
 * 抽查 assets/objects 是否真的存在。
 *
 * 「index json 在」不等于「资源在」：index 是 setup 下的，objects 要单独跑
 * `blockpilot assets`。只看 json 的闸门等于没有——1.19+ 的原版资源包就是 assets
 * 本身，零 assets 时标题画面渲染直接抛 NoSuchFileException（issue #2）。
 *
 * 抽样而不是全量：3888 个文件逐个 stat 要几百毫秒，而抽查 24 个分布在不同前缀的
 * 对象已经足以区分「装过」和「完全没装」。
 */
export function probeAssetObjects(
  indexPath: string,
  objectsDir: string,
  sampleSize = 24,
): AssetsProbe | null {
  if (!existsSync(indexPath)) return null
  let index: AssetIndex
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8')) as AssetIndex
  } catch {
    return null
  }
  const hashes = [...new Set(Object.values(index.objects ?? {}).map((o) => o.hash))]
  if (hashes.length === 0) {
    return { total: 0, sampled: 0, present: 0, missingSample: [] }
  }

  const step = Math.max(1, Math.floor(hashes.length / sampleSize))
  const picked: string[] = []
  for (let i = 0; i < hashes.length && picked.length < sampleSize; i += step) {
    const h = hashes[i]
    if (h !== undefined) picked.push(h)
  }

  const missingSample: string[] = []
  let present = 0
  for (const hash of picked) {
    if (existsSync(join(objectsDir, hash.slice(0, 2), hash))) present += 1
    else missingSample.push(hash)
  }
  return { total: hashes.length, sampled: picked.length, present, missingSample }
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
      codes: {
        ok: 'assets.ok',
        cached: 'assets.cached',
        failed: 'assets.failed',
        progressId: 'assets',
      },
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
