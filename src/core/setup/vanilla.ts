import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { AsyncQueue, runPool } from '../download/queue.js'
import { defaultSources, chinaFirstSources } from '../download/sources.js'
import type { DownloadSource, DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import { fetchVersionJson } from '../version/fetch.js'
import type { VersionJson } from '../version/types.js'
import { detectEnv, type LaunchEnv } from '../launch/env.js'
import { pickLibraries } from '../launch/command.js'

export interface VanillaSetupOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources?: readonly DownloadSource[]
  readonly concurrency?: number
  readonly mirror?: boolean
  /** 只打印任务不下载 */
  readonly dryRun?: boolean
}

export interface VanillaSetupResult {
  readonly versionId: string
  readonly total: number
  readonly downloaded: number
  readonly skipped: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly nativesExtracted: number
  readonly totalBytes: number
}

/**
 * 构造原版安装的下载任务。
 *
 * 三类：client jar、所有 library（普通 + 原生）、assetIndex。
 * 注意 natives jar 也要下——它虽然不进 classpath，但解压时需要文件本体。
 */
export function buildVanillaTasks(
  version: VersionJson,
  env: LaunchEnv,
  layout: Layout,
): DownloadTask[] {
  const tasks: DownloadTask[] = []

  const client = version.downloads?.client
  if (client !== undefined) {
    tasks.push({
      url: client.url,
      fileName: `${version.id}.jar`,
      destPath: layout.clientJar(version.id),
      expectedSize: client.size,
      hashes: { sha1: client.sha1 },
    })
  }

  const { jars, natives } = pickLibraries(version, env)
  for (const lib of [...jars, ...natives]) {
    const art = lib.downloads?.artifact
    if (art === undefined) continue
    tasks.push({
      url: art.url,
      fileName: basename(art.path),
      destPath: join(layout.libraries, ...art.path.split('/')),
      expectedSize: art.size,
      hashes: { sha1: art.sha1 },
    })
  }

  if (version.assetIndex !== undefined) {
    tasks.push({
      url: version.assetIndex.url,
      fileName: `${version.assetIndex.id}.json`,
      destPath: layout.assetIndex(version.assetIndex.id),
      expectedSize: version.assetIndex.size,
      hashes: { sha1: version.assetIndex.sha1 },
    })
  }

  return tasks
}

/** 解压原生库。跳过 META-INF 和带 .. 的路径（防 zip slip）。 */
export function extractNatives(version: VersionJson, env: LaunchEnv, layout: Layout): number {
  const dir = layout.nativesDir(version.id)
  mkdirSync(dir, { recursive: true })

  let count = 0
  const { natives } = pickLibraries(version, env)
  for (const lib of natives) {
    const art = lib.downloads?.artifact
    if (art === undefined) continue
    const jarPath = join(layout.libraries, ...art.path.split('/'))
    if (!existsSync(jarPath)) continue

    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(readFileSync(jarPath)))
    } catch {
      continue
    }

    const exclude = lib.extract?.exclude ?? ['META-INF/']
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue
      if (name.includes('..')) continue
      if (exclude.some((e) => name.startsWith(e))) continue
      const out = join(dir, name)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, data)
      count += 1
    }
  }
  return count
}

export function createVanillaSetup(opts: VanillaSetupOptions): Operation<VanillaSetupResult> {
  return defineOperation<VanillaSetupResult>('vanilla-setup', async function* (signal) {
    const env = detectEnv()
    const version = await fetchVersionJson(opts.versionId, {
      ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
      signal,
    })

    const tasks = buildVanillaTasks(version, env, opts.layout)
    const totalBytes = tasks.reduce((s, t) => s + t.expectedSize, 0)

    yield Op.log('info', 'setup.tasks', {
      tasks: tasks.length,
      totalBytes,
      version: version.id,
    })

    if (opts.dryRun === true) {
      yield Op.result({
        versionId: version.id,
        total: tasks.length,
        downloaded: 0,
        skipped: 0,
        failed: [],
        nativesExtracted: 0,
        totalBytes,
      })
      yield Op.done()
      return
    }

    const sources = opts.sources ?? defaultSources()
    const concurrency = opts.concurrency ?? 4

    const queue = new AsyncQueue<OpEvent<never>>()
    const failed: { fileName: string; error: string }[] = []
    let done = 0
    let downloaded = 0
    let skipped = 0
    let bytes = 0

    const runner = runPool(tasks, concurrency, async (task) => {
      if (signal.aborted) return
      try {
        const outcome = await downloadOne(task, sources, signal)
        if (outcome.skipped) skipped += 1
        else {
          downloaded += 1
          bytes += outcome.bytes
        }
        queue.push(
          Op.log('info', outcome.skipped ? 'setup.cached' : 'setup.ok', {
            file: task.fileName,
            source: outcome.source,
          }),
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        failed.push({ fileName: task.fileName, error: message })
        queue.push(Op.log('error', 'setup.failed', { file: task.fileName, error: message }))
      } finally {
        done += 1
        queue.push(Op.progress('setup', done, tasks.length, task.fileName))
      }
    }).finally(() => queue.close())

    for await (const ev of queue.drain()) yield ev
    await runner

    const nativesExtracted = extractNatives(version, env, opts.layout)
    yield Op.log('info', 'setup.natives', { extracted: nativesExtracted })

    yield Op.result({
      versionId: version.id,
      total: tasks.length,
      downloaded,
      skipped,
      failed,
      nativesExtracted,
      totalBytes: bytes,
    })
    yield Op.done()
  })
}

/** 供 CLI 选择源列表用 */
export function pickSources(china: boolean): readonly DownloadSource[] {
  return china ? chinaFirstSources() : defaultSources()
}
