import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadSource } from '../download/types.js'
import type { Layout } from '../layout.js'
import { fetchJavaBinary } from '../sources/adoptium.js'
import type { JavaOs } from '../sources/adoptium.js'
import { readTarGz, writeTarEntries } from './tar.js'
import { probeJava } from './probe.js'
import type { JavaInstall } from './types.js'

export interface JavaInstallOptions {
  readonly layout: Layout
  /** 需要的大版本，如 17 / 21 */
  readonly major: number
  readonly sources?: readonly DownloadSource[]
  readonly runtimeOs?: JavaOs
  /** 测试注入：探测某个 java 可执行文件的大版本 */
  readonly probe?: (path: string) => Promise<JavaInstall | null>
  /** 测试注入：取 Adoptium 的下载信息（返回 null = 没有这个构建） */
  readonly fetchBinary?: typeof fetchJavaBinary
}

export interface JavaInstallResult {
  readonly java: JavaInstall
  readonly release: string
  readonly bytes: number
  /** 命中已有安装时为 true */
  readonly skipped: boolean
}

function detectOs(): JavaOs {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'mac'
  return 'linux'
}

const EXE = process.platform === 'win32' ? 'java.exe' : 'java'

/**
 * 已装好的运行时里找 java 可执行文件。Adoptium 的 zip 顶层只有一个目录，
 * 但 `<root>/java` 下可以有多套（17 与 21 共存），所以返回全部候选。
 */
function findJavaExecutables(javaDir: string): string[] {
  if (!existsSync(javaDir)) return []
  const out: string[] = []
  const direct = join(javaDir, 'bin', EXE)
  if (existsSync(direct)) out.push(direct)
  for (const name of readdirSync(javaDir)) {
    const candidate = join(javaDir, name, 'bin', EXE)
    if (existsSync(candidate)) out.push(candidate)
  }
  return out
}

type ProbeFn = (path: string) => Promise<JavaInstall | null>

const defaultProbe: ProbeFn = (path) => probeJava(path, 'managed')

/** 找与目标大版本**恰好一致**的那套。`java install 17` 不该因为装了 21 就跳过。 */
async function findExactMajor(
  javaDir: string,
  major: number,
  probe: ProbeFn,
): Promise<JavaInstall | null> {
  for (const path of findJavaExecutables(javaDir)) {
    const probed = await probe(path)
    if (probed !== null && probed.major === major) return probed
  }
  return null
}

/** 解压 zip。跳过目录项与 `..` 路径（zip slip）。 */
function extractZip(zipPath: string, destDir: string): number {
  const entries = unzipSync(new Uint8Array(readFileSync(zipPath)))
  let count = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    if (name.includes('..')) continue
    const out = join(destDir, ...name.split('/'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    count += 1
  }
  return count
}

/** 解压 tar.gz。可执行位与 slip 防护都在 tar.ts 里。 */
function extractTarGz(tarPath: string, destDir: string): { files: number; symlinks: number } {
  return writeTarEntries(readTarGz(new Uint8Array(readFileSync(tarPath))), destDir)
}

export function createJavaInstall(opts: JavaInstallOptions): Operation<JavaInstallResult> {
  return defineOperation<JavaInstallResult>('java-install', async function* (signal) {
    const javaRoot = join(opts.layout.root, 'java')
    mkdirSync(javaRoot, { recursive: true })

    /**
     * 已经装过**同一大版本**就不重复下载。
     *
     * 以前的条件是 `major >= opts.major`，于是 `java install 17` 在只装了 21 的机器上
     * 直接回「已存在 Java 21」——用户要 17 却拿到 21，而 Forge 1.20.1 这类老包
     * 恰恰在 21 上有毛病（实测会在标题画面自行退出）。
     */
    const probe = opts.probe ?? defaultProbe
    const existing = await findExactMajor(javaRoot, opts.major, probe)
    if (existing !== null) {
      yield Op.log('info', 'java.already_installed', { path: existing.path, major: existing.major })
      yield Op.result({ java: existing, release: existing.version, bytes: 0, skipped: true })
      yield Op.done()
      return
    }

    const os = opts.runtimeOs ?? detectOs()
    yield Op.log('info', 'java.lookup', { major: opts.major, os })
    const binary = await (opts.fetchBinary ?? fetchJavaBinary)(opts.major, os, signal)
    if (binary === null) {
      yield Op.failed('JAVA_NOT_FOUND', `Adoptium 没有 Java ${opts.major} 的 ${os} 构建`)
      return
    }

    yield Op.log('info', 'java.download', {
      release: binary.release,
      size: binary.size,
      checksum: binary.checksum.slice(0, 12),
    })

    const cacheDir = join(javaRoot, '.cache')
    mkdirSync(cacheDir, { recursive: true })
    const archivePath = join(cacheDir, binary.fileName)

    const outcome = await downloadOne(
      {
        url: binary.url,
        fileName: binary.fileName,
        destPath: archivePath,
        expectedSize: binary.size,
        hashes: { sha256: binary.checksum },
      },
      opts.sources ?? defaultSources(),
      signal,
    )

    yield Op.log('info', 'java.extract', {
      bytes: outcome.bytes,
      cached: outcome.skipped,
      source: outcome.source,
      ...(outcome.credit === undefined ? {} : { credit: outcome.credit }),
    })
    const entries =
      binary.archive === 'tar.gz'
        ? extractTarGz(archivePath, javaRoot)
        : { files: extractZip(archivePath, javaRoot), symlinks: 0 }
    yield Op.log('info', 'java.extracted', {
      files: entries.files,
      ...(entries.symlinks > 0 ? { symlinks: entries.symlinks } : {}),
    })

    // 目录里可能已经有别的版本（17 与 21 共存），挑出刚装的那套
    const installed = await findExactMajor(javaRoot, opts.major, probe)
    const javaPath = installed?.path ?? findJavaExecutables(javaRoot)[0]
    if (javaPath === undefined) {
      yield Op.failed('JAVA_EXECUTABLE_MISSING', '解压完了但找不到 bin/java')
      return
    }

    const probed = installed ?? (await probe(javaPath))
    if (probed === null) {
      yield Op.failed('JAVA_PROBE_FAILED', `解压出来的 java 跑不起来：${javaPath}`)
      return
    }
    if (probed.major < opts.major) {
      yield Op.failed(
        'JAVA_VERSION_MISMATCH',
        `装到的是 Java ${probed.major}，需要 ${opts.major}`,
      )
      return
    }

    yield Op.log('info', 'java.ready', { path: probed.path, version: probed.version })
    yield Op.result({
      java: probed,
      release: binary.release,
      bytes: outcome.bytes,
      skipped: false,
    })
    yield Op.done()
  })
}
