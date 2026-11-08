import { fetchJson } from '../http.js'
import { USER_AGENT } from '../user-agent.js'

const FABRIC_META = 'https://meta.fabricmc.net/v2'
/**
 * BMCLAPI 的 Fabric 元数据镜像，路径与官方一致。
 *
 * 2026-10-28 实测：meta.fabricmc.net 在这台机器上 20 s 无响应，而镜像 0.17 s 返回。
 * `--china` 此前只作用于文件下载，元数据仍直连——结果是「加了镜像也装不上 Fabric」。
 */
const FABRIC_META_MIRROR = 'https://bmclapi2.bangbang93.com/fabric-meta/v2'
/**
 * Legacy Fabric —— 1.6.4 / 1.7.10 / 1.12.2 这些「官方 Fabric 不支持」的版本。
 *
 * 结构与 fabricmc 完全一致（`/v2/versions/loader/<mc>`、`profile/json` 同格式），
 * 所以只换 base。maven 是 `maven.legacyfabric.net`，写在 profile 的 `url` 字段里。
 *
 * 官方 meta 对不支持的版本返回 **400 + 空数组**，以前被当成普通失败，
 * 用户只看到 `unexpected error: ... HTTP 400`（issue #10）。
 */
const FABRIC_META_LEGACY = 'https://meta.legacyfabric.net/v2'
const TIMEOUT_MS = 20_000

interface MetaOptions {
  /** true 时元数据走 BMCLAPI */
  readonly mirror?: boolean
  /** Legacy Fabric（1.6.x / 1.7.10 / 1.12.2）。BMCLAPI 的镜像没有它的元数据 */
  readonly legacy?: boolean
}

function metaBase(opts: MetaOptions = {}): string {
  if (opts.legacy === true) return FABRIC_META_LEGACY
  return opts.mirror === true ? FABRIC_META_MIRROR : FABRIC_META
}

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
    /** Legacy Fabric 的老式原生库声明：{ windows: 'natives-windows' } */
    readonly natives?: Readonly<Record<string, string>>
    readonly downloads?: {
      readonly artifact?: { readonly path: string; readonly url: string; readonly sha1: string; readonly size: number }
    }
  }[]
  readonly arguments?: { readonly game: readonly string[]; readonly jvm: readonly string[] }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(url, signal === undefined ? {} : { signal })
}

export async function listLoaders(
  gameVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<readonly FabricLoaderEntry[]> {
  return getJson<FabricLoaderEntry[]>(
    `${metaBase(opts)}/versions/loader/${gameVersion}`,
    signal,
  )
}

export type FabricFlavor = 'official' | 'legacy'

/**
 * 这个 MC 版本该用哪套 Fabric。
 *
 * 官方 meta 对不支持的版本（1.6.4 / 1.7.10 / 1.12.2）返回 **400 + 空数组**，
 * 以前直接抛成 `unexpected error`。先探官方、再探 Legacy，
 * 两套都没有才算真的不支持。
 */
export async function detectFabricFlavor(
  gameVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<FabricFlavor | null> {
  for (const flavor of ['official', 'legacy'] as const) {
    try {
      const list = await listLoaders(gameVersion, signal, {
        ...opts,
        legacy: flavor === 'legacy',
        // Legacy 的元数据只有官方站点有，BMCLAPI 镜像不覆盖
        mirror: flavor === 'legacy' ? false : opts.mirror,
      })
      if (list.length > 0) return flavor
    } catch {
      // 400 与网络失败都先落到这里：换下一套再试
    }
  }
  return null
}

/** 不指定版本时取最新的 stable。全都不稳定就取第一个。 */
export async function pickLoaderVersion(
  gameVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<string> {
  const list = await listLoaders(gameVersion, signal, opts)
  if (list.length === 0) throw new Error(`Fabric 没有 ${gameVersion} 的 loader`)
  const stable = list.find((l) => l.loader.stable)
  return (stable ?? list[0])!.loader.version
}

export async function fetchProfile(
  gameVersion: string,
  loaderVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<FabricProfile> {
  return getJson<FabricProfile>(
    `${metaBase(opts)}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`,
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
