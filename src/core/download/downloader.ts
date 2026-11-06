import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'

import type { DownloadOutcome, DownloadSource, DownloadTask, SourceAttempt } from './types.js'
import { USER_AGENT } from '../user-agent.js'

type Algo = 'sha1' | 'sha256' | 'sha512'

function pickAlgo(hashes: Readonly<Record<string, string>>): Algo | null {
  // 优先强哈希：sha512 > sha256 > sha1
  if (typeof hashes['sha512'] === 'string') return 'sha512'
  if (typeof hashes['sha256'] === 'string') return 'sha256'
  if (typeof hashes['sha1'] === 'string') return 'sha1'
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
 * 镜像会看 UA，也可能用 HTTP 200 返回错误页。
 *
 * 实测 MCIM 在服务不可用时返回 `200 OK` + 一张 2231 字节的
 * "Service Temporarily Unavailable" HTML。状态码完全不可信——
 * 这就是为什么每个文件都必须过哈希，而不是看 res.ok 就落盘。
 */
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
    let bytes = 0
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm()
        hash.update(chunk)
        bytes += chunk.byteLength
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await once(out, 'finish')
    } finally {
      if (!out.closed) out.destroy()
    }
    return { bytes, digest: hash.digest('hex'), finalUrl: res.url }
  } catch (err) {
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
  sources: readonly DownloadSource[],
  signal: AbortSignal,
  /** 测试注入：把空闲超时调短，不用等 30 秒 */
  opts: { readonly idleTimeoutMs?: number } = {},
): Promise<DownloadOutcome> {
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
  const partPath = `${task.destPath}.part`
  const attempts: SourceAttempt[] = []

  for (const source of sources) {
    if (signal.aborted) throw new Error('aborted')
    const raw = new URL(task.url)
    const target = source.rewrite(raw)
    // null = 这个源不覆盖该 URL。跳过，不计入 attempts，也不算失败。
    if (target === null) continue

    try {
      const { bytes, digest, finalUrl } = await fetchToFile(
        target,
        partPath,
        algo,
        signal,
        opts.idleTimeoutMs,
      )
      // 先比大小：镜像返回 HTML 错误页时，这一步就能挡住，省掉一次哈希
      if (task.expectedSize > 0 && bytes !== task.expectedSize) {
        throw new Error(`size mismatch (${bytes} != ${task.expectedSize})，可能拿到了错误页`)
      }
      if (digest !== expected) {
        throw new Error(`hash mismatch (${algo} ${digest.slice(0, 8)}… != ${expected.slice(0, 8)}…)`)
      }
      renameSync(partPath, task.destPath)
      attempts.push({ source: source.name, ok: true })
      return {
        fileName: task.fileName,
        bytes,
        source: source.name,
        credit: source.credit,
        finalUrl,
        skipped: false,
        attempts,
      }
    } catch (err) {
      attempts.push({
        source: source.name,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
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
  throw new Error(`所有源都失败 — ${detail}`)
}
