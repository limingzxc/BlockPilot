/**
 * CurseForge 的文件元数据。
 *
 * CF 的 `manifest.json` 只有 `projectID/fileID` 两个数字，没有 URL 也没有哈希。
 * 官方接口 `POST /v1/mods/files`（一次最多 100 个 fileID）要 `x-api-key`。
 *
 * **但用户不该被迫去申请 key。** Prism/ATLauncher 之所以「不问 key」，是因为
 * 它们随启动器内置了一个；开源项目内置 key 会泄露并被吊销，所以正确做法是
 * 走镜像——国内启动器（PCL2 等）都是这么做的。
 *
 * 于是这里有两条实现，由 {@link resolveCurseforge} 选：
 * - {@link CurseforgeSource}：有 key 时走官方批量接口（快、权威）
 * - {@link MirrorCurseforgeSource}：没 key 时走 MCIM 的 `/curseforge` 代理，
 *   逐个 `GET /v1/mods/{id}/files/{fid}`（镜像没代理批量 POST）
 *
 * key 从环境变量 `BLOCKPILOT_CF_API_KEY` 或 `--curseforge-key` 取，不落盘、不进日志。
 */
import {
  type CfDependencyRelation,
  type CfFileInfo,
  type CfFileQuery,
  CurseforgeError,
  type CurseforgeLike,
} from '../core/curseforge.js'
import { errMessage } from '../core/errors.js'
import { NetworkError } from '../core/http.js'
import { USER_AGENT } from '../core/user-agent.js'

export type {
  CfDependency,
  CfDependencyRelation,
  CfFileInfo,
  CfFileQuery,
  CurseforgeLike,
} from '../core/curseforge.js'
/**
 * 契约与纯映射在 core，这里只放实现。re-export 保持既有 import 路径可用。
 */
export { CurseforgeError, cfFileToVersionInfo } from '../core/curseforge.js'

export const CURSEFORGE_API = 'https://api.curseforge.com/v1'
/**
 * MCIM 的 CurseForge API 代理。路径与官方一致（`/curseforge` 前缀 + `/v1/...`），
 * 不需要 key。实测 2026-11-09：`GET /mods/238222` 与
 * `GET /mods/238222/files/3040523` 都返回 200 且带 downloadUrl；
 * 批量 `POST /mods/files` 没有代理（404），所以只能逐个查。
 */
export const CURSEFORGE_MIRROR = 'https://mod.mcimirror.top/curseforge/v1'
const BATCH = 100
const TIMEOUT_MS = 20_000

/** 官方 `modLoaderType` 枚举。镜像用同一套值。 */
const CF_LOADER_TYPE: Readonly<Record<string, number>> = {
  forge: 1,
  fabric: 4,
  quilt: 5,
  neoforge: 6,
}

/** CF 的 hash algo：1 = sha1，2 = md5。下载校验只认 sha1。 */
const ALGO_SHA1 = 1

/**
 * 429 / 5xx 的重试次数。
 *
 * 免 key 的镜像路径是「一个文件一次 GET」，271 个文件的包就是 271 次请求；
 * 以前任意一次 429 都会抛错终止整轮解析，用户看到的是「CF 接口限流」，
 * 而其实只差几百毫秒。这里退避重试两次，仍然失败才上报。
 */
const RETRIES = 2

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 对 429/5xx 做指数退避；4xx 与 2xx 原样返回，由调用方解释。 */
async function fetchRetrying(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { ...init, signal })
    if (res.status !== 429 && res.status < 500) return res
    if (attempt >= RETRIES) return res
    await sleep(500 * 2 ** attempt, signal)
  }
}

interface RawFile {
  readonly id?: number
  readonly modId?: number
  readonly fileName?: string
  readonly displayName?: string
  readonly fileLength?: number
  readonly downloadUrl?: string | null
  readonly gameVersions?: readonly string[]
  readonly hashes?: readonly { readonly algo?: number; readonly value?: string }[]
  readonly dependencies?: readonly { readonly modId?: number; readonly relationType?: number }[]
}

/** 1=Embedded 2=Optional 3=Required 4=Tool 5=Incompatible 6=Include */
function toRelation(raw: number | undefined): CfDependencyRelation {
  switch (raw) {
    case 3:
      return 'required'
    case 2:
      return 'optional'
    case 5:
      return 'incompatible'
    default:
      return 'other'
  }
}

function toFileInfo(raw: RawFile): CfFileInfo | null {
  if (raw.id === undefined || raw.fileName === undefined) return null
  const sha1 = raw.hashes?.find((h) => h.algo === ALGO_SHA1)?.value
  return {
    fileId: raw.id,
    modId: raw.modId ?? 0,
    fileName: raw.fileName,
    displayName: raw.displayName ?? raw.fileName,
    size: raw.fileLength ?? 0,
    downloadUrl:
      typeof raw.downloadUrl === 'string' && raw.downloadUrl !== '' ? raw.downloadUrl : null,
    hashes: typeof sha1 === 'string' ? { sha1 } : {},
    gameVersions: raw.gameVersions ?? [],
    dependencies: (raw.dependencies ?? [])
      .filter((d): d is { modId: number; relationType?: number } => typeof d.modId === 'number')
      .map((d) => ({ modId: d.modId, relation: toRelation(d.relationType) })),
  }
}

export interface CurseforgeOptions {
  readonly apiKey?: string
  /** 测试注入 */
  readonly apiBase?: string
}

export class CurseforgeSource implements CurseforgeLike {
  private readonly key: string | undefined
  private readonly api: string
  readonly label = 'api.curseforge.com'

  constructor(opts: CurseforgeOptions = {}) {
    this.key = opts.apiKey ?? process.env.BLOCKPILOT_CF_API_KEY
    this.api = (opts.apiBase ?? CURSEFORGE_API).replace(/\/+$/, '')
  }

  get configured(): boolean {
    return this.key !== undefined && this.key !== ''
  }

  /**
   * fileID → 文件信息。查不到的 id 不会出现在 map 里。
   *
   * 权限/配额问题抛 CurseforgeError（带稳定 code），网络问题抛 NetworkError——
   * 两者对用户的含义完全不同：一个是去换 key，一个是去查网络。
   */
  async getFiles(
    files: readonly CfFileQuery[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<number, CfFileInfo>> {
    const fileIds = files.map((f) => f.fileId)
    if (!this.configured) {
      throw new CurseforgeError(
        'CF_API_KEY_MISSING',
        '没有 CurseForge API key：设置环境变量 BLOCKPILOT_CF_API_KEY 后重试',
      )
    }
    const ids = [...new Set(fileIds.filter((id) => Number.isFinite(id) && id > 0))]
    const out = new Map<number, CfFileInfo>()
    for (let i = 0; i < ids.length; i += BATCH) {
      if (signal.aborted) break
      const chunk = ids.slice(i, i + BATCH)
      const rows = await this.post(chunk, signal)
      for (const row of rows) {
        const info = toFileInfo(row)
        if (info !== null) out.set(info.fileId, info)
      }
    }
    return out
  }

  async getLatestFile(
    projectId: number,
    gameVersion: string,
    loader: string | null,
    signal: AbortSignal,
  ): Promise<CfFileInfo | null> {
    if (!this.configured) {
      throw new CurseforgeError(
        'CF_API_KEY_MISSING',
        '没有 CurseForge API key：设置环境变量 BLOCKPILOT_CF_API_KEY 后重试',
      )
    }
    const params = new URLSearchParams({ gameVersion, pageSize: '1' })
    if (loader !== null && CF_LOADER_TYPE[loader] !== undefined) {
      params.set('modLoaderType', String(CF_LOADER_TYPE[loader]))
    }
    const url = `${this.api}/mods/${projectId}/files?${params.toString()}`
    let res: Response
    try {
      res = await fetchRetrying(
        url,
        {
          headers: {
            'x-api-key': this.key ?? '',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
        },
        AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      )
    } catch (err) {
      if (signal.aborted) throw err
      throw new NetworkError(url, errMessage(err))
    }
    if (res.status === 401 || res.status === 403) {
      throw new CurseforgeError(
        'CF_API_KEY_INVALID',
        `CurseForge 拒绝了这个 API key（HTTP ${res.status}）`,
      )
    }
    if (res.status === 429) {
      throw new CurseforgeError(
        'CF_API_RATE_LIMIT',
        'CurseForge 接口限流（HTTP 429）；等一会儿重试',
      )
    }
    if (!res.ok) throw new CurseforgeError('CF_API_ERROR', `CurseForge 接口返回 HTTP ${res.status}`)
    const body = (await res.json()) as { readonly data?: readonly RawFile[] }
    const first = body.data?.[0]
    return first === undefined ? null : toFileInfo(first)
  }

  private async post(fileIds: readonly number[], signal: AbortSignal): Promise<readonly RawFile[]> {
    const url = `${this.api}/mods/files`
    let res: Response
    try {
      res = await fetchRetrying(
        url,
        {
          method: 'POST',
          headers: {
            'x-api-key': this.key ?? '',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({ fileIds }),
        },
        AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      )
    } catch (err) {
      if (signal.aborted) throw err
      throw new NetworkError(url, errMessage(err))
    }

    if (res.status === 401 || res.status === 403) {
      throw new CurseforgeError(
        'CF_API_KEY_INVALID',
        `CurseForge 拒绝了这个 API key（HTTP ${res.status}）；到 console.curseforge.com 确认 key 与权限`,
      )
    }
    if (res.status === 429) {
      throw new CurseforgeError(
        'CF_API_RATE_LIMIT',
        'CurseForge 接口限流（HTTP 429）；等一会儿重试，或减少一次请求的文件数',
      )
    }
    if (!res.ok) {
      throw new CurseforgeError('CF_API_ERROR', `CurseForge 接口返回 HTTP ${res.status}`)
    }
    const body = (await res.json()) as { readonly data?: readonly RawFile[] }
    return body.data ?? []
  }
}

/**
 * 免 key 的 CurseForge 解析：走 MCIM 的代理，逐个文件查。
 *
 * 代价是请求数：271 个文件的包要 271 次 GET（并发 6，实测 30–60 秒），
 * 而有 key 时官方批量接口是 3 次。所以只在没有 key 时用。
 */
export class MirrorCurseforgeSource implements CurseforgeLike {
  readonly configured = true
  readonly label = 'MCIM · mod.mcimirror.top'

  constructor(
    private readonly api: string = CURSEFORGE_MIRROR,
    private readonly concurrency = 6,
  ) {}

  async getFiles(
    files: readonly CfFileQuery[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<number, CfFileInfo>> {
    const seen = new Set<number>()
    const queue: CfFileQuery[] = []
    for (const f of files) {
      if (!Number.isFinite(f.fileId) || f.fileId <= 0) continue
      if (seen.has(f.fileId)) continue
      seen.add(f.fileId)
      queue.push(f)
    }

    const out = new Map<number, CfFileInfo>()
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (signal.aborted) return
        const next = queue[cursor]
        cursor += 1
        if (next === undefined) return
        const info = await this.one(next, signal)
        if (info !== null) out.set(info.fileId, info)
      }
    }
    const width = Math.max(1, Math.min(this.concurrency, queue.length))
    await Promise.all(Array.from({ length: width }, worker))
    return out
  }

  async getLatestFile(
    projectId: number,
    gameVersion: string,
    loader: string | null,
    signal: AbortSignal,
  ): Promise<CfFileInfo | null> {
    const params = new URLSearchParams({ gameVersion, pageSize: '1' })
    if (loader !== null && CF_LOADER_TYPE[loader] !== undefined) {
      params.set('modLoaderType', String(CF_LOADER_TYPE[loader]))
    }
    const url = `${this.api}/mods/${projectId}/files?${params.toString()}`
    let res: Response
    try {
      res = await fetchRetrying(
        url,
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
        AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      )
    } catch (err) {
      if (signal.aborted) throw err
      throw new NetworkError(url, errMessage(err))
    }
    if (res.status === 404) return null
    if (res.status === 429) {
      throw new CurseforgeError(
        'CF_API_RATE_LIMIT',
        'CurseForge 镜像限流（HTTP 429）；等一会儿重试',
      )
    }
    if (!res.ok) throw new CurseforgeError('CF_API_ERROR', `CurseForge 镜像返回 HTTP ${res.status}`)
    const body = (await res.json()) as { readonly data?: readonly RawFile[] }
    const first = body.data?.[0]
    return first === undefined ? null : toFileInfo(first)
  }

  private async one(f: CfFileQuery, signal: AbortSignal): Promise<CfFileInfo | null> {
    const url = `${this.api}/mods/${f.projectId}/files/${f.fileId}`
    let res: Response
    try {
      res = await fetchRetrying(
        url,
        { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } },
        AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      )
    } catch (err) {
      if (signal.aborted) throw err
      throw new NetworkError(url, errMessage(err))
    }

    // 镜像里没有这个文件（老文件未收录，或作者已删）：让调用方按「拿不到」处理
    if (res.status === 404) return null
    if (res.status === 429) {
      throw new CurseforgeError(
        'CF_API_RATE_LIMIT',
        'CurseForge 镜像限流（HTTP 429）；等一会儿重试，或设置 BLOCKPILOT_CF_API_KEY 走官方接口',
      )
    }
    if (!res.ok) {
      throw new CurseforgeError('CF_API_ERROR', `CurseForge 镜像返回 HTTP ${res.status}`)
    }
    const body = (await res.json()) as { readonly data?: RawFile }
    return body.data === undefined ? null : toFileInfo(body.data)
  }
}

/**
 * 选一条路：有 key 走官方，没有就走镜像。
 *
 * `allowMirror === false`（CLI 的 `--no-cf-mirror`）时不做回落——
 * 用于排查「到底是谁没给文件」，也保证 ADR-0021 的旧行为还能复现。
 */
export function resolveCurseforge(
  opts: { readonly apiKey?: string; readonly allowMirror?: boolean } = {},
): CurseforgeLike {
  const official = new CurseforgeSource(opts.apiKey === undefined ? {} : { apiKey: opts.apiKey })
  if (official.configured) return official
  if (opts.allowMirror === false) return official
  return new MirrorCurseforgeSource()
}
