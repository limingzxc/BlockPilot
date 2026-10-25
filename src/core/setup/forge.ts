import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { downloadOne } from '../download/downloader.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadSource } from '../download/types.js'
import type { Layout } from '../layout.js'
import { fetchMavenSha1 } from '../sources/fabric.js'
import { installerSpec, recommendedForge } from '../sources/forge.js'
import type { InstallerKind } from '../sources/forge.js'

export interface ForgeSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** forge 或 neoforge */
  readonly kind?: InstallerKind
  /** 不填则查 recommended（仅 Forge 支持） */
  readonly forgeVersion?: string
  /** 跑 installer 用的 java */
  readonly java: string
  readonly sources?: readonly DownloadSource[]
}

export interface ForgeSetupResult {
  readonly versionId: string
  readonly forgeVersion: string
  readonly installerRan: boolean
  readonly versionJsonPath: string
}

const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000

/**
 * installer 会检查 `launcher_profiles.json`，没有就拒绝安装：
 * `There is no minecraft launcher profile in "<dir>", you need to run the launcher first!`
 *
 * 这是官方启动器的标记文件，我们不实现它，但需要一个空壳骗过 installer。
 */
function ensureLauncherProfiles(root: string): void {
  const path = join(root, 'launcher_profiles.json')
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2))
}

interface InstallerRun {
  readonly code: number | null
  readonly tail: readonly string[]
}

function runInstaller(
  java: string,
  jarPath: string,
  root: string,
  signal: AbortSignal,
): Promise<InstallerRun> {
  return new Promise((resolve, reject) => {
    // installer 无 GUI 时靠这两个参数走命令行模式
    const child = spawn(java, ['-jar', jarPath, '--installClient', root], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const tail: string[] = []
    const onLine = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      for (const line of text.split(/\r?\n/)) {
        if (line === '') continue
        tail.push(line)
        if (tail.length > 30) tail.shift()
      }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`installer 超时（${INSTALLER_TIMEOUT_MS / 60000} 分钟）`))
    }, INSTALLER_TIMEOUT_MS)

    const onAbort = () => {
      child.kill()
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, tail })
    })
  })
}

export function createForgeSetup(opts: ForgeSetupOptions): Operation<ForgeSetupResult> {
  return defineOperation<ForgeSetupResult>('forge-setup', async function* (signal) {
    const kind: InstallerKind = opts.kind ?? 'forge'
    const forgeVersion =
      opts.forgeVersion ?? (await recommendedForge(opts.gameVersion, signal))
    if (forgeVersion === null || forgeVersion === undefined) {
      yield Op.failed(
        'NO_INSTALLER_VERSION',
        `查不到 MC ${opts.gameVersion} 推荐的 ${kind} 版本`,
        '用 --loader 显式指定',
      )
      return
    }

    const spec = installerSpec(kind, opts.gameVersion, forgeVersion)
    const versionId = spec.versionId
    const jsonPath = opts.layout.versionJson(versionId)

    // 已经装过就直接返回，installer 很慢且会重写文件
    if (existsSync(jsonPath)) {
      yield Op.log('info', 'forge.already_installed', { versionId })
      yield Op.result({ versionId, forgeVersion, installerRan: false, versionJsonPath: jsonPath })
      yield Op.done()
      return
    }

    const url = spec.url
    yield Op.log('info', 'forge.installer_url', { url })

    const sha1 = await fetchMavenSha1(url, signal)
    if (sha1 === null) {
      yield Op.failed('NO_HASH', `取不到 installer 的 sha1：${url}`, '没有哈希的文件不下载')
      return
    }

    mkdirSync(opts.layout.root, { recursive: true })
    const tmpJar = join(opts.layout.root, `.forge-installer-${versionId}.jar`)
    const outcome = await downloadOne(
      {
        url,
        fileName: `forge-installer.jar`,
        destPath: tmpJar,
        expectedSize: 0,
        hashes: { sha1 },
      },
      opts.sources ?? defaultSources(),
      signal,
    )
    yield Op.log('info', 'forge.installer_downloaded', { bytes: outcome.bytes })

    ensureLauncherProfiles(opts.layout.root)

    yield Op.log('info', 'forge.installer_run', { note: '下载依赖并给 client 打补丁，通常 1–3 分钟' })
    const run = await runInstaller(opts.java, tmpJar, opts.layout.root, signal)

    if (run.code !== 0) {
      yield Op.log('error', 'forge.installer_failed', { code: run.code, tail: run.tail })
      yield Op.failed(
        'INSTALLER_FAILED',
        `Forge installer 退出码 ${run.code ?? '-'}`,
        run.tail.slice(-3).join(' / '),
      )
      return
    }

    if (!existsSync(jsonPath)) {
      yield Op.failed(
        'INSTALLER_NO_OUTPUT',
        'installer 报告成功，但没有生成版本 JSON',
        jsonPath,
      )
      return
    }

    // installer 本身已经下好了 libraries 和 patched client，不需要再补
    try {
      unlinkSync(tmpJar)
    } catch {
      // 删不掉不影响使用
    }

    yield Op.log('info', 'forge.installed', { versionId })
    yield Op.result({ versionId, forgeVersion, installerRan: true, versionJsonPath: jsonPath })
    yield Op.done()
  })
}
