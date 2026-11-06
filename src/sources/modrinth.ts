import { fetchJson, NetworkError } from '../core/http.js'
import { USER_AGENT } from '../core/user-agent.js'
import type {
  ContentSource,
  DependencyKind,
  DependencyResolver,
  DepFilter,
  ProjectNamer,
  VersionInfo,
} from '../core/sources.js'

export const MODRINTH_API = 'https://api.modrinth.com/v2'
/** MCIM 的 API 镜像。实测 2026-10-25 可用，对元数据查询有真实加速。 */
export const MODRINTH_API_MCIM = 'https://mod.mcimirror.top/modrinth/v2'

/** Modrinth 强制要求可识别的 User-Agent，缺了会被 400。规则见 core/user-agent.ts */
const UA = USER_AGENT
const BATCH = 100
const TIMEOUT_MS = 20_000

export interface ModrinthOptions {
  /** 默认官方；国内可传 MODRINTH_API_MCIM */
  readonly apiBase?: string
}

interface RawVersion {
  readonly id: string
  readonly project_id: string
  readonly name: string
  readonly game_versions: readonly string[]
  readonly loaders: readonly string[]
  readonly version_type?: 'release' | 'beta' | 'alpha'
  readonly files?: readonly {
    readonly url: string
    readonly filename: string
    readonly size: number
    readonly primary: boolean
    readonly hashes: Readonly<Record<string, string>>
  }[]
  readonly dependencies?: readonly {
    readonly version_id: string | null
    readonly project_id: string | null
    readonly dependency_type: DependencyKind
  }[]
}

function toVersionInfo(raw: RawVersion): VersionInfo {
  return {
    projectId: raw.project_id,
    versionId: raw.id,
    name: raw.name,
    gameVersions: raw.game_versions,
    loaders: raw.loaders,
    dependencies: (raw.dependencies ?? []).map((d) => ({
      projectId: d.project_id,
      versionId: d.version_id,
      kind: d.dependency_type,
    })),
    files: (raw.files ?? []).map((f) => ({
      url: f.url,
      filename: f.filename,
      size: f.size,
      primary: f.primary,
      hashes: f.hashes,
    })),
  }
}

/** Modrinth 的 project / version id 都是 8 位 base62。非法 id 会让整批请求 400。 */
const ID_RE = /^[0-9A-Za-z]{8}$/

interface RawProject {
  readonly id: string
  readonly title?: string
  readonly slug?: string
}

export class ModrinthSource implements ContentSource, DependencyResolver, ProjectNamer {
  readonly name = 'modrinth'
  private readonly api: string

  constructor(opts: ModrinthOptions = {}) {
    this.api = (opts.apiBase ?? MODRINTH_API).replace(/\/+$/, '')
  }

  async getVersions(
    versionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly VersionInfo[]> {
    const valid = versionIds.filter((id) => ID_RE.test(id))
    const out: VersionInfo[] = []
    for (let i = 0; i < valid.length; i += BATCH) {
      if (signal.aborted) break
      const chunk = valid.slice(i, i + BATCH)
      try {
        out.push(...(await this.fetchBatch(chunk, signal)))
      } catch (err) {
        // 网络断了就别装作「这几个 id 查不到」：逐个重试只会把一次故障
        // 放大成 48 条「可能已下架」，还让预检给出 exit 0。
        if (err instanceof NetworkError) throw err
        // 一个坏 id 不该让整批失败。降级成逐个请求，只丢坏的那一个。
        for (const id of chunk) {
          if (signal.aborted) break
          try {
            out.push(...(await this.fetchBatch([id], signal)))
          } catch {
            // 单个失败保持静默：调用方会把它算作未解析
          }
        }
      }
    }
    return out
  }

  private async fetchBatch(
    ids: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly VersionInfo[]> {
    const url = `${this.api}/versions?ids=${encodeURIComponent(JSON.stringify(ids))}`
    const rows = await fetchJson<RawVersion[]>(url, { signal, headers: { 'User-Agent': UA } })
    return rows.map(toVersionInfo)
  }

  /**
   * projectId → 项目标题。只用于文案，失败不抛错。
   *
   * `/projects?ids=[...]` 一次最多 100 个；不存在的 id 会被 Modrinth 直接忽略，
   * 返回的数组可能比请求的短，所以按返回结果建 map，不全就当没查到。
   */
  async getProjectNames(
    projectIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>> {
    const valid = [...new Set(projectIds.filter((id) => ID_RE.test(id)))]
    const out = new Map<string, string>()
    for (let i = 0; i < valid.length; i += BATCH) {
      if (signal.aborted) break
      const chunk = valid.slice(i, i + BATCH)
      try {
        const rows = await fetchJson<RawProject[]>(
          `${this.api}/projects?ids=${encodeURIComponent(JSON.stringify(chunk))}`,
          { signal, headers: { 'User-Agent': UA } },
        )
        for (const p of rows) {
          if (typeof p.title === 'string' && p.title !== '') out.set(p.id, p.title)
        }
      } catch (err) {
        // 名字是锦上添花：整批失败就放弃这批，不让预检因此变红
        if (err instanceof NetworkError && signal.aborted) throw err
      }
    }
    return out
  }

  /**
   * 反查：给定 projectId，找一个兼容当前实例的版本。
   * 优先 release，没有就退回最新的一条。查不到返回 null，不抛错——
   * 在依赖闭包里「查不到」是正常结局，不是异常。
   */
  async resolve(
    projectId: string,
    filter: DepFilter,
    signal: AbortSignal,
  ): Promise<VersionInfo | null> {
    if (!ID_RE.test(projectId)) return null

    const params = new URLSearchParams()
    params.set('game_versions', JSON.stringify([filter.gameVersion]))
    if (filter.loader !== null) params.set('loaders', JSON.stringify([filter.loader]))

    const url = `${this.api}/project/${encodeURIComponent(projectId)}/version?${params.toString()}`
    try {
      const rows = await fetchJson<RawVersion[]>(url, { signal, headers: { 'User-Agent': UA } })
      if (!Array.isArray(rows) || rows.length === 0) return null
      const picked = rows.find((r) => r.version_type === 'release') ?? rows[0]
      return picked === undefined ? null : toVersionInfo(picked)
    } catch (err) {
      // 「查不到」是正常结局；「连不上」不是——交给上面报网络错误
      if (err instanceof NetworkError) throw err
      return null
    }
  }
}
