/**
 * CurseForge 的文件元数据。
 *
 * CF 的 `manifest.json` 只有 `projectID/fileID` 两个数字，没有 URL 也没有哈希。
 * 要变成可下载的任务，必须调 `POST /v1/mods/files`（一次最多 100 个 fileID），
 * 请求头带 `x-api-key`。这就是 ADR-0021 说的「CF 需要 API key」。
 *
 * key 从环境变量 `BLOCKPILOT_CF_API_KEY` 取，不落盘、不进日志。
 */
import { NetworkError } from '../core/http.js'
import { USER_AGENT } from '../core/user-agent.js'

export const CURSEFORGE_API = 'https://api.curseforge.com/v1'
const BATCH = 100
const TIMEOUT_MS = 20_000

/** CF 的 hash algo：1 = sha1，2 = md5。下载校验只认 sha1。 */
const ALGO_SHA1 = 1

export type CfDependencyRelation = 'required' | 'optional' | 'incompatible' | 'other'

export interface CfDependency {
  readonly modId: number
  readonly relation: CfDependencyRelation
}

export interface CfFileInfo {
  readonly fileId: number
  readonly modId: number
  readonly fileName: string
  readonly displayName: string
  readonly size: number
  /** 作者可以关掉第三方下载，这时是 null */
  readonly downloadUrl: string | null
  readonly hashes: Readonly<Record<string, string>>
  /** CF 的 gameVersions 混着游戏版本与加载器名，如 ["1.12.2", "Forge"] */
  readonly gameVersions: readonly string[]
  readonly dependencies: readonly CfDependency[]
}

/** CF API 的稳定失败码。文案可以改，code 给脚本用。 */
export class CurseforgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CurseforgeError'
    this.code = code
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
    downloadUrl: typeof raw.downloadUrl === 'string' && raw.downloadUrl !== '' ? raw.downloadUrl : null,
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

export class CurseforgeSource {
  private readonly key: string | undefined
  private readonly api: string

  constructor(opts: CurseforgeOptions = {}) {
    this.key = opts.apiKey ?? process.env['BLOCKPILOT_CF_API_KEY']
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
    fileIds: readonly number[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<number, CfFileInfo>> {
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

  private async post(fileIds: readonly number[], signal: AbortSignal): Promise<readonly RawFile[]> {
    const url = `${this.api}/mods/files`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.key ?? '',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ fileIds }),
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), signal]),
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw new NetworkError(url, err instanceof Error ? err.message : String(err))
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
