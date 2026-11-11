import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { downloadOne } from '../download/downloader.js'
import { defaultSources } from '../download/sources.js'
import type { Mirror } from '../download/types.js'
import { Op } from '../events.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { javaProxyArgs } from '../proxy.js'
import { fetchMavenSha1 } from '../sources/fabric.js'
import type { InstallerKind } from '../sources/forge.js'
import { installerSpec, recommendedForge, recommendedNeoForge } from '../sources/forge.js'
import type { LoaderInstallResult } from './loader.js'

export interface ForgeSetupOptions {
  readonly layout: Layout
  readonly gameVersion: string
  /** forge 或 neoforge */
  readonly kind?: InstallerKind
  /** 不填则查 recommended（仅 Forge 支持） */
  readonly forgeVersion?: string
  /** 跑 installer 用的 java */
  readonly java: string
  /** installer 是独立 JVM，有自己的下载栈，要显式传代理 */
  readonly proxy?: string
  readonly sources?: readonly Mirror[]
}

export interface ForgeSetupResult {
  readonly versionId: string
  readonly forgeVersion: string
  readonly installerRan: boolean
  readonly versionJsonPath: string
}

function installerResult(r: ForgeSetupResult): LoaderInstallResult {
  return {
    versionId: r.versionId,
    loaderVersion: r.forgeVersion,
    versionJsonPath: r.versionJsonPath,
    failed: [],
    detail: { kind: 'installer', installerRan: r.installerRan },
  }
}

const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000

/**
 * NeoForge 被墙时的镜像（出处：MC百科 论坛的应对帖，2025-08 仓库下线/被墙时）。
 * forgecdn 与官方 maven 路径完全兼容，只换域名——installer 内部的下载 URL
 * 硬编码在 install_profile.json / version.json 里，替换文本即可生效。
 */
const NEOFORGE_MIRROR = {
  from: 'maven.neoforged.net',
  to: 'neoforged.forgecdn.net',
}

/**
 * 把 installer 里的下载地址换成镜像。
 *
 * 三个已知入口：install_profile.json（51 处）、version.json（31 处）、
 * SimpleInstaller.class 里的一个字符串常量。**class 不动**——「maven.neoforged.net」
 * 19 字节换成「neoforged.forgecdn.net」21 字节会破坏常量池的长度前缀，
 * 整个类文件就废了。而下载 URL 由两个 JSON 提供，class 里那个常量不参与下载，
 * 所以只改 JSON 就够（社区的重打包做法也只改这两个文件）。
 *
 * 只在 kind=neoforge 且没配代理时用：有代理时直连官方保真度更高。
 * 替换发生在 sha1 校验之后——先证明下载的字节是对的，再动它。
 */
export function mirrorNeoForgeInstaller(jar: Uint8Array): Uint8Array {
  const entries = unzipSync(jar)
  const out: Record<string, Uint8Array> = {}
  for (const [name, data] of Object.entries(entries)) {
    if (name === 'install_profile.json' || name === 'version.json') {
      out[name] = strToU8(strFromU8(data).replaceAll(NEOFORGE_MIRROR.from, NEOFORGE_MIRROR.to))
    } else {
      out[name] = data
    }
  }
  return zipSync(out)
}

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
  proxy?: string,
): Promise<InstallerRun> {
  return new Promise((resolve, reject) => {
    // installer 无 GUI 时靠这两个参数走命令行模式
    const child = spawn(java, [...javaProxyArgs(proxy), '-jar', jarPath, '--installClient', root], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const tail: string[] = []
    let buffer = ''
    const record = (line: string): void => {
      if (line === '') return
      tail.push(line)
      if (tail.length > 30) tail.shift()
    }
    const onLine = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) record(line)
    }
    // 结尾没有换行符的半行也要留下：失败时最后一句往往就是原因
    const flush = (): void => {
      if (buffer !== '') {
        record(buffer)
        buffer = ''
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
    // close 而不是 exit：exit 可能早于 stdout/stderr 排空
    child.on('close', (code) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      flush()
      resolve({ code, tail })
    })
  })
}

export function createForgeSetup(opts: ForgeSetupOptions): Operation<LoaderInstallResult> {
  return defineOperation<LoaderInstallResult>('forge-setup', async function* (signal) {
    const kind: InstallerKind = opts.kind ?? 'forge'
    let forgeVersion = opts.forgeVersion
    if (forgeVersion === undefined) {
      // Forge 有 promotions_slim.json，NeoForge 没有——两者的「推荐版本」来源不同，
      // 一律查 Forge 的 promotions 会让 `blockpilot neoforge <mc>` 拿到一个 Forge 版本号
      const probe =
        kind === 'neoforge'
          ? await recommendedNeoForge(opts.gameVersion, signal)
          : await recommendedForge(opts.gameVersion, signal)
      if (probe.status === 'unreachable') {
        yield Op.failed(
          'NETWORK_ERROR',
          `查 ${kind} 推荐版本失败：${probe.detail}`,
          '检查网络；也可以用 --loader 显式指定版本',
        )
        return
      }
      if (probe.status === 'absent') {
        yield Op.failed(
          'NO_INSTALLER_VERSION',
          `查不到 MC ${opts.gameVersion} 推荐的 ${kind} 版本${probe.detail === undefined ? '' : `（${probe.detail}）`}`,
          '用 --loader 显式指定',
        )
        return
      }
      forgeVersion = probe.value
    }

    const spec = installerSpec(kind, opts.gameVersion, forgeVersion)
    const versionId = spec.versionId
    const jsonPath = opts.layout.versionJson(versionId)

    // 已经装过就直接返回，installer 很慢且会重写文件
    if (existsSync(jsonPath)) {
      yield Op.log('info', 'forge.already_installed', { versionId })
      yield Op.result(
        installerResult({
          versionId,
          forgeVersion,
          installerRan: false,
          versionJsonPath: jsonPath,
        }),
      )
      yield Op.done()
      return
    }

    const url = spec.url
    yield Op.log('info', 'forge.installer_url', { url })

    // sha1 与下载走同一套镜像规则，否则会出现「下载有镜像、校验没镜像」的断裂
    const sha1Url = new URL(`${url}.sha1`)
    const sha1Candidates = (opts.sources ?? defaultSources())
      .map((src) => src.rewrite(sha1Url))
      .filter((u): u is string => u !== null)
    const sha1 = await fetchMavenSha1(url, {
      ...(signal === undefined ? {} : { signal }),
      candidates: sha1Candidates,
    })
    if (sha1.status === 'unreachable') {
      yield Op.failed(
        'NETWORK_ERROR',
        `取不到 installer 的 sha1（网络失败）：${sha1.detail}`,
        '检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理',
      )
      return
    }
    if (sha1.status === 'absent') {
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
        hashes: { sha1: sha1.value },
      },
      opts.sources ?? defaultSources(),
      signal,
    )
    yield Op.log('info', 'forge.installer_downloaded', { bytes: outcome.bytes })

    // 没配代理时把 installer 内部的下载地址换成 forgecdn 镜像。
    // 有代理时保持原包直连官方——保真度更高。
    if (kind === 'neoforge' && opts.proxy === undefined) {
      try {
        writeFileSync(tmpJar, mirrorNeoForgeInstaller(readFileSync(tmpJar)))
        yield Op.log('info', 'forge.installer_mirrored', {
          from: NEOFORGE_MIRROR.from,
          to: NEOFORGE_MIRROR.to,
        })
      } catch (err) {
        // 镜像化失败不拦流程：installer 也许本来就直连得通（比如已设系统代理）
        yield Op.log('warn', 'forge.installer_mirror_failed', { error: String(err) })
      }
    }

    ensureLauncherProfiles(opts.layout.root)

    yield Op.log('info', 'forge.installer_run', {
      note: '下载依赖并给 client 打补丁，通常 1–3 分钟',
    })

    // installer 下载几百 MB 的库，网络抖一下就整个失败。它自己有缓存，
    // 重跑会跳过已下载的部分，所以失败重试一次代价很小、收益很大——
    // 实测走代理时装 NeoForge 第一次就挂在 net.neoforged:bus:8.0.5，重试直接过
    let run = await runInstaller(opts.java, tmpJar, opts.layout.root, signal, opts.proxy)
    if (run.code !== 0) {
      yield Op.log('warn', 'forge.installer_retry', { code: run.code, tail: run.tail.slice(-1) })
      run = await runInstaller(opts.java, tmpJar, opts.layout.root, signal, opts.proxy)
    }

    if (run.code !== 0) {
      yield Op.log('error', 'forge.installer_failed', { code: run.code, tail: run.tail })
      yield Op.failed(
        'INSTALLER_FAILED',
        `Forge installer 退出码 ${run.code ?? '-'}（已重试一次）`,
        run.tail.slice(-3).join(' / '),
      )
      return
    }

    if (!existsSync(jsonPath)) {
      yield Op.failed('INSTALLER_NO_OUTPUT', 'installer 报告成功，但没有生成版本 JSON', jsonPath)
      return
    }

    // installer 本身已经下好了 libraries 和 patched client，不需要再补
    try {
      unlinkSync(tmpJar)
    } catch {
      // 删不掉不影响使用
    }

    yield Op.log('info', 'forge.installed', { versionId })
    yield Op.result(
      installerResult({
        versionId,
        forgeVersion,
        installerRan: true,
        versionJsonPath: jsonPath,
      }),
    )
    yield Op.done()
  })
}
