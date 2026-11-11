import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { errMessage } from '../errors.js'
import { NetworkError } from '../http.js'
import { USER_AGENT } from '../user-agent.js'
import type { DownloadOutcome, DownloadTask, Mirror, SourceAttempt } from './types.js'

type Algo = 'sha1' | 'sha256' | 'sha512'

/**
 * 下载层的信任边界。
 *
 * 文件名与 URL 来自第三方（mrpack 清单、CF 镜像、Modrinth API），不能直接信。
 * 这里集中收口，避免「CF 做了清洗、deploy <slug> 又漏了」这类逐调用方遗漏。
 * 本地回环允许 http，供 E2E 的本地 HTTP 服务使用。
 */
const ALLOWED_DOWNLOAD_HOSTS: ReadonlySet<string> = new Set([
  'cdn.modrinth.com',
  'cdn-raw.modrinth.com',
  'github.com',
  'www.github.com',
  'objects.githubusercontent.com',
  // GitHub Release 资产的 302 落点（Adoptium 的 Java 包）
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'piston-data.mojang.com',
  'launcher.mojang.com',
  'launchermeta.mojang.com',
  'piston-meta.mojang.com',
  'resources.download.minecraft.net',
  'libraries.minecraft.net',
  'files.minecraftforge.net',
  'maven.minecraftforge.net',
  'maven.fabricmc.net',
  'meta.fabricmc.net',
  'maven.legacyfabric.net',
  'maven.quiltmc.org',
  'maven.neoforged.net',
  'neoforged.forgecdn.net',
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  'mod.mcimirror.top',
  'bmclapi2.bangbang93.com',
  'mirrors.tuna.tsinghua.edu.cn',
  // 部分加载器 profile 的库直接引用 Maven Central / Google Maven
  'repo1.maven.org',
  'repo.maven.apache.org',
  'maven.google.com',
])

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

/** `--allow-host` 的写法与 mrpack 清单一致：精确域名，或 `.suffix` 后缀。 */
function matchesExtraHost(host: string, extraHosts: readonly string[]): boolean {
  for (const raw of extraHosts) {
    const rule = raw.trim().toLowerCase()
    if (rule === '') continue
    if (rule.startsWith('.')) {
      if (host.endsWith(rule)) return true
    } else if (host === rule) {
      return true
    }
  }
  return false
}

function isAllowedHost(hostname: string, extraHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase()
  return (
    ALLOWED_DOWNLOAD_HOSTS.has(host) ||
    host.endsWith('.forgecdn.net') ||
    host.endsWith('.minecraft.net') ||
    host.endsWith('.mojang.com') ||
    host.endsWith('.fabricmc.net') ||
    isLoopback(host) ||
    matchesExtraHost(host, extraHosts)
  )
}

/**
 * 校验下载 URL：只允许 https（本地回环例外），且域名在白名单内。
 *
 * `extraHosts` 只来自用户显式写的 `--allow-host`；第三方清单里的地址不享受这条豁免。
 */
export function assertSafeDownloadUrl(raw: string, extraHosts: readonly string[] = []): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`下载地址不是合法 URL：${raw}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`拒绝下载：只允许 https，收到 ${url.protocol}//${url.hostname}`)
  }
  if (!isAllowedHost(url.hostname, extraHosts)) {
    throw new Error(`拒绝下载：域名不在白名单：${url.hostname}`)
  }
  return url
}

/** 文件名只取最后一段，防止 `../../x` 借下载任务写出目标目录。 */
export function assertSafeFileName(fileName: string): string {
  const name = basename(fileName)
  if (name === '' || name === '.' || name === '..' || name !== fileName) {
    throw new Error(`拒绝下载：文件名不安全：${fileName}`)
  }
  return name
}

function pickAlgo(hashes: Readonly<Record<string, string>>): Algo | null {
  // 优先强哈希：sha512 > sha256 > sha1
  if (typeof hashes.sha512 === 'string') return 'sha512'
  if (typeof hashes.sha256 === 'string') return 'sha256'
  if (typeof hashes.sha1 === 'string') return 'sha1'
  return null
}

async function hashFile(path: string, algo: Algo): Promise<string> {
  const hash = createHash(algo)
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 已存在且哈希匹配才算通过。没有哈希的文件不做校验，但要显式声明。 */
export async function verifyExisting(
  task: DownloadTask,
): Promise<{ ok: boolean; reason?: 'missing' | 'no-hash' | 'mismatch' }> {
  if (!existsSync(task.destPath)) return { ok: false, reason: 'missing' }
  const algo = pickAlgo(task.hashes)
  if (algo === null) return { ok: false, reason: 'no-hash' }
  const actual = await hashFile(task.destPath, algo)
  return actual === task.hashes[algo] ? { ok: true } : { ok: false, reason: 'mismatch' }
}

/**
 * 多久没收到任何字节就判定为卡住。
 *
 * JSON 请求有 20 s 超时（http.ts），文件下载却一直没有——一个半死不活的
 * TCP 连接会让 `deploy` 停在 "23/51" 上不动，既不报错也不结束，用户只能
 * 看着屏幕猜是不是自己网坏了。这里按「空闲」计时，不设总时长：
 * 大文件可以慢慢下，但连续 30 s 一个字节都没有就换下一个源。
 */
const IDLE_TIMEOUT_MS = 30_000

async function fetchToFile(
  url: string,
  partPath: string,
  algo: Algo,
  signal: AbortSignal,
  idleTimeoutMs: number = IDLE_TIMEOUT_MS,
): Promise<{ bytes: number; digest: string; finalUrl: string }> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })

  let idleTimer: NodeJS.Timeout | undefined
  let stalled = false
  /**
   * 写盘错误必须有人接住。
   *
   * 以前只在 `once(out, 'drain'/'finish')` 的等待窗口里才有 error 监听：
   * 磁盘写满或杀软锁住 .part 时，错误常发生在等下一个网络块的间隙，
   * 没有 listener 就变成 uncaughtException，整个进程带堆栈崩掉。
   */
  let writeError: Error | undefined
  const arm = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, idleTimeoutMs)
  }

  try {
    arm()
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (res.body === null) throw new Error('empty response body')

    const hash = createHash(algo)
    const out = createWriteStream(partPath)
    out.on('error', (err) => {
      writeError ??= err
      controller.abort()
    })
    let bytes = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm()
        if (writeError !== undefined) throw writeError
        hash.update(chunk)
        bytes += chunk.byteLength
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await once(out, 'finish')
      if (writeError !== undefined) throw writeError
    } finally {
      if (!out.closed) out.destroy()
    }
    return { bytes, digest: hash.digest('hex'), finalUrl: res.url }
  } catch (err) {
    if (writeError !== undefined) throw writeError
    if (stalled) {
      throw new Error(`超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据，已中止`)
    }
    throw err
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * 下载单个文件。
 *
 * 顺序：缓存命中 → 逐个源尝试。每个源下载后都要校验哈希，
 * **校验失败等同于下载失败**——镜像活着不代表内容正确（ADR-0005）。
 */
export async function downloadOne(
  task: DownloadTask,
  sources: readonly Mirror[],
  signal: AbortSignal,
  /** 测试注入：把空闲超时调短，不用等 30 秒 */
  opts: { readonly idleTimeoutMs?: number } = {},
): Promise<DownloadOutcome> {
  assertSafeFileName(task.fileName)
  assertSafeDownloadUrl(task.url, task.allowHosts ?? [])

  const cached = await verifyExisting(task)
  if (cached.ok) {
    return {
      fileName: task.fileName,
      bytes: statSync(task.destPath).size,
      source: 'cache',
      skipped: true,
      attempts: [],
    }
  }

  const algo = pickAlgo(task.hashes)
  if (algo === null) {
    throw new Error('拒绝下载：任务没有 sha1/sha512，无法验证来源')
  }
  const expected = task.hashes[algo] as string

  mkdirSync(dirname(task.destPath), { recursive: true })
  // 带上 pid：两个进程同时下同一个文件时，固定 `.part` 会互相覆盖，
  // 最终 rename 的可能是对方写了一半的字节
  const partPath = `${task.destPath}.${process.pid}.part`
  const attempts: SourceAttempt[] = []

  for (const source of sources) {
    if (signal.aborted) throw new Error('aborted')
    const raw = new URL(task.url)
    const target = source.rewrite(raw)
    // null = 这个源不覆盖该 URL。跳过，不计入 attempts，也不算失败。
    if (target === null) continue

    try {
      // 镜像可能把地址改到任意 host；改写结果同样要过白名单
      assertSafeDownloadUrl(target, task.allowHosts ?? [])
      const { bytes, digest, finalUrl } = await fetchToFile(
        target,
        partPath,
        algo,
        signal,
        opts.idleTimeoutMs,
      )
      // **哈希是唯一裁判**（ADR-0005）。`expectedSize` 只是索引里的元数据，
      // 和 CDN 上的真实字节数本来就可能不一致：Modrinth 上确有 fileSize 差
      // 1 字节、sha1 完全相同的文件（Better MC 的 balm / geckolib 等 14 个）。
      // 以前先比 size 再比哈希，合法文件直接判死，热门整合包装不上。
      /**
       * 镜像会看 UA，也可能用 HTTP 200 返回错误页。
       *
       * 实测 MCIM 在服务不可用时返回 `200 OK` + 一张 2231 字节的
       * "Service Temporarily Unavailable" HTML。状态码完全不可信——
       * 这就是为什么每个文件都必须过哈希，而不是看 res.ok 就落盘。
       */
      if (digest !== expected) {
        const sizeNote =
          task.expectedSize > 0 && bytes !== task.expectedSize
            ? `，体积 ${bytes} 与索引 ${task.expectedSize} 也不符`
            : ''
        throw new Error(
          `hash mismatch (${algo} ${digest.slice(0, 8)}… != ${expected.slice(0, 8)}…)${sizeNote}，可能拿到了错误页`,
        )
      }
      const sizeMismatch = task.expectedSize > 0 && bytes !== task.expectedSize
      renameSync(partPath, task.destPath)
      attempts.push({ source: source.name, ok: true })
      return {
        fileName: task.fileName,
        bytes,
        source: source.name,
        credit: source.credit,
        finalUrl,
        skipped: false,
        ...(sizeMismatch ? { sizeMismatch: true } : {}),
        attempts,
      }
    } catch (err) {
      attempts.push({
        source: source.name,
        ok: false,
        error: errMessage(err),
      })
      if (existsSync(partPath)) {
        try {
          unlinkSync(partPath)
        } catch {
          // 清不掉半成品不影响后续重试，只是留个垃圾文件
        }
      }
    }
  }

  const detail = attempts.map((a) => `${a.source}: ${a.error ?? 'unknown'}`).join('; ')
  // 全源失败是最常见的网络故障，不是「unexpected error」：抛 NetworkError，
  // 让 CLI 走那条带地址与建议的分支（issue #6）。
  // 没有任何源覆盖这个 URL 时 attempts 为空，也要给出可读的原因。
  throw new NetworkError(
    task.url,
    attempts.length === 0 ? '没有可用的下载源覆盖这个地址' : `所有源都失败 — ${detail}`,
  )
}
