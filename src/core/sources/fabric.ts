import { USER_AGENT } from '../user-agent.js'

const FABRIC_META = 'https://meta.fabricmc.net/v2'
const TIMEOUT_MS = 20_000

export interface FabricLoaderEntry {
  readonly loader: { readonly version: string; readonly stable: boolean }
  readonly intermediary?: { readonly version: string }
}

export interface FabricProfile {
  readonly id: string
  readonly inheritsFrom: string
  readonly mainClass: string
  readonly libraries: readonly {
    readonly name: string
    readonly url?: string
    readonly downloads?: {
      readonly artifact?: { readonly path: string; readonly url: string; readonly sha1: string; readonly size: number }
    }
  }[]
  readonly arguments?: { readonly game: readonly string[]; readonly jvm: readonly string[] }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(TIMEOUT_MS),
    ]),
  })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return (await res.json()) as T
}

export async function listLoaders(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<readonly FabricLoaderEntry[]> {
  return getJson<FabricLoaderEntry[]>(`${FABRIC_META}/versions/loader/${gameVersion}`, signal)
}

/** 不指定版本时取最新的 stable。全都不稳定就取第一个。 */
export async function pickLoaderVersion(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<string> {
  const list = await listLoaders(gameVersion, signal)
  if (list.length === 0) throw new Error(`Fabric 没有 ${gameVersion} 的 loader`)
  const stable = list.find((l) => l.loader.stable)
  return (stable ?? list[0])!.loader.version
}

export async function fetchProfile(
  gameVersion: string,
  loaderVersion: string,
  signal?: AbortSignal,
): Promise<FabricProfile> {
  return getJson<FabricProfile>(
    `${FABRIC_META}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`,
    signal,
  )
}

/**
 * 把 maven 坐标展开成仓库路径。
 *
 * Fabric 的 profile 只给 `name` + `url`，不像 Mojang 那样带 downloads.artifact。
 * 这意味着**没有现成的 sha1**，得自己去仓库取 `.sha1` 文件。
 */
// 已移到 core/version/maven.ts，这里保留 re-export 兼容
export { mavenCoordToPath } from '../version/maven.js'
/** 从仓库的 .sha1 文件取哈希。取不到就返回 null——没有哈希的文件不允许下载。 */
/**
 * 取仓库侧的 .sha1。
 *
 * `candidates` 是「这个文件的候选地址列表」——与下载器同源的镜像规则
 * （direct 永远在最后兜底）。此前只试官方地址，结果 NeoForge 被墙时
 * sha1 探测先死，镜像还没机会上场：下载器走 forgecdn，探测却卡在官方域。
 */
export async function fetchMavenSha1(
  url: string,
  opts?: {
    readonly signal?: AbortSignal
    /** 候选地址。缺省就只试官方 */
    readonly candidates?: readonly string[]
  },
): Promise<string | null> {
  const candidates = opts?.candidates ?? [`${url}.sha1`]
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
  const signal = AbortSignal.any([
    ...(opts?.signal === undefined ? [] : [opts.signal]),
    timeoutSignal,
  ])

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': USER_AGENT }, signal })
      if (!res.ok) continue
      const text = (await res.text()).trim().split(/\s+/)[0] ?? ''
      if (/^[0-9a-f]{40}$/i.test(text)) return text.toLowerCase()
    } catch {
      // 换下一个候选
    }
  }
  return null
}
