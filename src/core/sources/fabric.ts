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
export async function fetchMavenSha1(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${url}.sha1`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(TIMEOUT_MS),
      ]),
    })
    if (!res.ok) return null
    const text = (await res.text()).trim().split(/\s+/)[0] ?? ''
    return /^[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : null
  } catch {
    return null
  }
}
