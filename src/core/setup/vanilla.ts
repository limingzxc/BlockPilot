import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources, chinaFirstSources } from '../download/sources.js'
import type { DownloadSource, DownloadTask } from '../download/types.js'
import { writeInstanceMarker } from '../instance/marker.js'
import type { Layout } from '../layout.js'
import { fetchVersionJson } from '../version/fetch.js'
import type { Library, VersionJson } from '../version/types.js'
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

/**
 * 26.x 起 Mojang 把原生库按用途拆进子目录，JVM 参数直接写
 * `-Djava.library.path=${natives_directory}/java`（JNA / Netty 同理）。
 *
 * 仍然把 DLL 全倒进 natives 根目录的话，LWJGL 在 `natives/java` 下找不到
 * `lwjgl.dll`，首启就死在 `UnsatisfiedLinkError: Failed to locate library`。
 * 判断依据用版本 JSON 自己写的参数，不猜版本号。
 */
export function usesSplitNatives(version: VersionJson): boolean {
  const jvm = version.arguments?.jvm ?? []
  return jvm.some((a) => typeof a === 'string' && a.includes('${natives_directory}/java'))
}

/** 原生库该落在哪个子目录。老版本（不拆分）一律返回空串，仍解到 natives 根。 */
export function nativeSubdir(lib: Library): string {
  const group = lib.name.split(':')[0] ?? ''
  if (group.startsWith('org.lwjgl')) return 'java'
  if (group.startsWith('net.java.dev.jna')) return 'jna'
  if (group.startsWith('io.netty')) return 'netty'
  return ''
}

/** 解压原生库。跳过 META-INF 和带 .. 的路径（防 zip slip）。 */
export function extractNatives(version: VersionJson, env: LaunchEnv, layout: Layout): number {
  const base = layout.nativesDir(version.id)
  const split = usesSplitNatives(version)
  mkdirSync(base, { recursive: true })
  if (split) {
    // 参数里只引用 java / jna / lwjgl / netty 四个目录。jna 与 netty 是
    // 「自己解压到这里」的临时目录，先把目录建好，省得运行时才报错
    for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
      mkdirSync(join(base, sub), { recursive: true })
    }
  }

  let count = 0
  const { natives } = pickLibraries(version, env)
  for (const lib of natives) {
    const art = lib.downloads?.artifact
    if (art === undefined) continue
    const jarPath = join(layout.libraries, ...art.path.split('/'))
    if (!existsSync(jarPath)) continue
    const dir = split ? join(base, nativeSubdir(lib)) : base

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

    // 把版本 JSON 落盘。它是 `launch` 唯一的本地依据：不写的话，下次启动即使
    // 文件全在也要回源拉一次，断网就起不来（加载器版本还要沿 inheritsFrom 找父版本）。
    const versionJsonPath = opts.layout.versionJson(version.id)
    mkdirSync(dirname(versionJsonPath), { recursive: true })
    writeFileSync(versionJsonPath, `${JSON.stringify(version, null, 2)}\n`, 'utf8')
    yield Op.log('info', 'setup.version_json', { path: versionJsonPath })

    const { downloaded, skipped, bytes, failed } = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: { ok: 'setup.ok', cached: 'setup.cached', failed: 'setup.failed', progressId: 'setup' },
    })

    const nativesExtracted = extractNatives(version, env, opts.layout)
    yield Op.log('info', 'setup.natives', { extracted: nativesExtracted })

    // 让 `preflight <实例目录>` 知道这是哪个游戏版本。只有 Prism 的实例有这份文件，
    // 自己装的反而查不出 MC 版本，说不通。
    const markerPath = writeInstanceMarker(opts.layout.gameDir, { gameVersion: version.id })
    yield Op.log('info', 'setup.marker', { path: markerPath })

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
