/**
 * 实例的已装内容清单（`<gameDir>/.blockpilot/lock.json`）。
 *
 * ADR-0001 说「已装内容必须是磁盘上的持久状态」，但此前只有 `mmc-pack.json`
 * 这个版本标记——它只能回答「这是什么版本」，不能回答「哪些文件装过、装全了没」。
 *
 * 这个文件同时解锁三件事：
 * - `verify`：不用重算整包的索引，按 lock 里的哈希逐个核对
 * - 半成品检测：`complete: false` 说明上次部署没走完
 * - 将来的 `update`：知道每个文件来自哪个 URL、哪个哈希
 *
 * 只记录**有哈希**的文件（mrpack / CF 清单里的任务）。overrides 里的配置
 * 没有可信哈希，记进来只会让 verify 误报。
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { DownloadTask } from '../download/types.js'
import { BlockPilotError } from '../errors.js'
import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import type { LoaderRef } from '../instance.js'
import { safeJoin } from '../safe-path.js'

const LOCK_VERSION = 1
const LOCK_DIR = '.blockpilot'
const LOCK_NAME = 'lock.json'

export interface LockedFile {
  /** 相对实例根，posix 分隔符 */
  readonly path: string
  readonly sha1?: string
  readonly sha512?: string
  readonly size: number
  readonly url?: string
  /** 内容源标识。update 用它反查新版本 */
  readonly projectId?: string
  readonly versionId?: string
  readonly source?: 'modrinth' | 'curseforge'
}

export interface LockFile {
  readonly version: 1
  readonly pack: {
    readonly name: string
    readonly kind: 'mrpack' | 'curseforge'
    /** 部署时用的包路径。只作记录，不参与校验 */
    readonly file: string
  }
  readonly target: {
    readonly gameVersion: string
    readonly loader: LoaderRef
  }
  /** false = 上次部署有失败项或没走完。verify 不会把它当成 ok */
  readonly complete: boolean
  readonly updatedAt: string
  readonly files: readonly LockedFile[]
}

export function lockPath(gameDir: string): string {
  return join(gameDir, LOCK_DIR, LOCK_NAME)
}

/** 下载任务 → lock 条目。路径转成相对实例根的 posix 形式，换台机器也能读。 */
export function toLockedFile(task: DownloadTask, gameDir: string): LockedFile {
  const rel = relative(gameDir, task.destPath).split(sep).join('/')
  const sha1 = task.hashes.sha1
  const sha512 = task.hashes.sha512
  return {
    path: rel,
    ...(sha1 === undefined ? {} : { sha1 }),
    ...(sha512 === undefined ? {} : { sha512 }),
    size: task.expectedSize,
    url: task.url,
    ...(task.meta?.projectId === undefined ? {} : { projectId: task.meta.projectId }),
    ...(task.meta?.versionId === undefined ? {} : { versionId: task.meta.versionId }),
    ...(task.meta?.source === undefined ? {} : { source: task.meta.source }),
  }
}

export interface BuildLockInput {
  readonly packName: string
  readonly packKind: 'mrpack' | 'curseforge'
  readonly packFile: string
  readonly gameVersion: string
  readonly loader: LoaderRef
  readonly complete: boolean
  readonly files: readonly LockedFile[]
  /** 注入时钟，测试用 */
  readonly now?: () => Date
}

export function buildLock(input: BuildLockInput): LockFile {
  return {
    version: LOCK_VERSION,
    pack: { name: input.packName, kind: input.packKind, file: input.packFile },
    target: { gameVersion: input.gameVersion, loader: input.loader },
    complete: input.complete,
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
    files: input.files,
  }
}

/** 原子写：先写 `.tmp` 再 rename，避免半截 JSON 被 verify 读到。 */
export function writeLock(gameDir: string, lock: LockFile): string {
  const path = lockPath(gameDir)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}

function assertLock(raw: unknown): LockFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BlockPilotError('LOCK_CORRUPT', 'lock.json 不是 JSON 对象')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== LOCK_VERSION) {
    throw new BlockPilotError(
      'LOCK_CORRUPT',
      `lock.json 的版本是 ${String(o.version)}，本程序只认 ${LOCK_VERSION}`,
      { hint: '重跑一次 deploy 会重新生成；旧文件可先备份' },
    )
  }
  if (!Array.isArray(o.files)) {
    throw new BlockPilotError('LOCK_CORRUPT', 'lock.json 缺少 files 数组')
  }
  const pack = o.pack
  const target = o.target
  if (typeof pack !== 'object' || pack === null) {
    throw new BlockPilotError('LOCK_CORRUPT', 'lock.json 缺少 pack')
  }
  if (typeof target !== 'object' || target === null) {
    throw new BlockPilotError('LOCK_CORRUPT', 'lock.json 缺少 target')
  }
  return raw as LockFile
}

/** 读 lock。文件不存在返回 null；存在但坏了抛 LOCK_CORRUPT。 */
export function readLock(gameDir: string): LockFile | null {
  const path = lockPath(gameDir)
  if (!existsSync(path)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new BlockPilotError('LOCK_CORRUPT', `lock.json 不是合法 JSON：${path}`)
  }
  return assertLock(parsed)
}

type Algo = 'sha1' | 'sha512'

function algoOf(file: LockedFile): Algo | null {
  if (file.sha512 !== undefined) return 'sha512'
  if (file.sha1 !== undefined) return 'sha1'
  return null
}

async function hashFile(path: string, algo: Algo): Promise<string> {
  const hash = createHash(algo)
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export type VerifyIssueReason = 'missing' | 'mismatch' | 'unreadable' | 'no-hash'

export interface VerifyIssue {
  readonly path: string
  readonly reason: VerifyIssueReason
}

export interface VerifyResult {
  readonly lock: LockFile
  readonly checked: number
  /** 哈希核对通过的文件数 */
  readonly ok: number
  readonly issues: readonly VerifyIssue[]
  /** 所有文件都在且哈希一致，且上次部署是完整的 */
  readonly okAll: boolean
}

export interface VerifyOptions {
  readonly gameDir: string
}

export function createVerify(opts: VerifyOptions): Operation<VerifyResult> {
  return defineOperation<VerifyResult>('verify', async function* (signal) {
    let lock: LockFile | null
    try {
      lock = readLock(opts.gameDir)
    } catch (err) {
      if (err instanceof BlockPilotError) {
        yield Op.failed(err.code, err.message, err.hint)
        return
      }
      throw err
    }
    if (lock === null) {
      yield Op.failed(
        'LOCK_NOT_FOUND',
        `这个实例没有 lock.json：${lockPath(opts.gameDir)}`,
        '用 blockpilot deploy <整合包> 装一次会生成；手工装出来的实例没有清单',
      )
      return
    }

    yield Op.log('info', 'verify.start', { files: lock.files.length, complete: lock.complete })

    const issues: VerifyIssue[] = []
    let checked = 0
    let ok = 0

    for (const file of lock.files) {
      if (signal.aborted) return
      checked += 1
      const abs = safeJoin(opts.gameDir, file.path)
      if (abs === null) {
        issues.push({ path: file.path, reason: 'unreadable' })
        continue
      }
      if (!existsSync(abs)) {
        issues.push({ path: file.path, reason: 'missing' })
        continue
      }
      const algo = algoOf(file)
      if (algo === null) {
        issues.push({ path: file.path, reason: 'no-hash' })
        continue
      }
      try {
        const actual = await hashFile(abs, algo)
        const expected = algo === 'sha512' ? file.sha512 : file.sha1
        if (actual === expected) ok += 1
        else issues.push({ path: file.path, reason: 'mismatch' })
      } catch {
        issues.push({ path: file.path, reason: 'unreadable' })
      }
    }

    yield Op.log('info', 'verify.done', {
      checked,
      ok,
      issues: issues.length,
      complete: lock.complete,
    })

    yield Op.result({
      lock,
      checked,
      ok,
      issues,
      okAll: issues.length === 0 && lock.complete,
    })
    yield Op.done()
  })
}
