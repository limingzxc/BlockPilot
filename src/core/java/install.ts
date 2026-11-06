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

/** 已装好的运行时里找 java 可执行文件。Adoptium 的 zip 顶层只有一个目录。 */
function findJavaExecutable(javaDir: string): string | null {
  if (!existsSync(javaDir)) return null
  const direct = join(javaDir, 'bin', EXE)
  if (existsSync(direct)) return direct
  for (const name of readdirSync(javaDir)) {
    const candidate = join(javaDir, name, 'bin', EXE)
    if (existsSync(candidate)) return candidate
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

    // 已经装过就不重复下载
    const existing = findJavaExecutable(javaRoot)
    if (existing !== null) {
      const probed = await probeJava(existing, 'managed')
      if (probed !== null && probed.major >= opts.major) {
        yield Op.log('info', 'java.already_installed', { path: existing, major: probed.major })
        yield Op.result({ java: probed, release: probed.version, bytes: 0, skipped: true })
        yield Op.done()
        return
      }
    }

    const os = opts.runtimeOs ?? detectOs()
    yield Op.log('info', 'java.lookup', { major: opts.major, os })
    const binary = await fetchJavaBinary(opts.major, os, signal)
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

    const javaPath = findJavaExecutable(javaRoot)
    if (javaPath === null) {
      yield Op.failed('JAVA_EXECUTABLE_MISSING', '解压完了但找不到 bin/java')
      return
    }

    const probed = await probeJava(javaPath, 'managed')
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
