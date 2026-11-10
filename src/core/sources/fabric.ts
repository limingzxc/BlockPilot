import { errMessage } from '../errors.js'
import { fetchJson, HttpError, NetworkError } from '../http.js'
import type { Probe } from '../probe.js'
import { absent, found, unreachable } from '../probe.js'
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
 * 官方 meta 对不支持的版本返回 **400 + 空数组**；当成普通失败会让用户
 * 只看到 `unexpected error: ... HTTP 400`（issue #10）。
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
      readonly artifact?: {
        readonly path: string
        readonly url: string
        readonly sha1: string
        readonly size: number
      }
    }
  }[]
  readonly arguments?: { readonly game: readonly string[]; readonly jvm?: readonly string[] }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(url, signal === undefined ? {} : { signal })
}

export async function listLoaders(
  gameVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<readonly FabricLoaderEntry[]> {
  return getJson<FabricLoaderEntry[]>(`${metaBase(opts)}/versions/loader/${gameVersion}`, signal)
}

export type FabricFlavor = 'official' | 'legacy'

/**
 * 这个 MC 版本该用哪套 Fabric。
 *
 * 官方 meta 对不支持的版本（1.6.4 / 1.7.10 / 1.12.2）返回 **400 + 空数组**。
 * 先探官方、再探 Legacy，两套都没有才算真的不支持。
 *
 * 返回三态：两套都「明确没有」才是 `absent`；任何一次请求连不上、或返回
 * 5xx/429，都只能算 `unreachable`——否则断网会被说成「这个版本没有 Fabric」。
 */
export async function detectFabricFlavor(
  gameVersion: string,
  signal?: AbortSignal,
  opts: MetaOptions = {},
): Promise<Probe<FabricFlavor>> {
  let unreachableDetail: string | undefined

  for (const flavor of ['official', 'legacy'] as const) {
    try {
      const list = await listLoaders(gameVersion, signal, {
        ...opts,
        legacy: flavor === 'legacy',
        // Legacy 的元数据只有官方站点有，BMCLAPI 镜像不覆盖
        ...(flavor === 'legacy' ? { mirror: false } : {}),
      })
      if (list.length > 0) return found(flavor)
    } catch (err) {
      if (signal?.aborted === true) throw err
      if (err instanceof NetworkError) {
        unreachableDetail ??= err.message
        continue
      }
      // 4xx（除 429）是「这套 meta 没有这个版本」，可以继续问下一套
      if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429)
        continue
      unreachableDetail ??= errMessage(err)
    }
  }

  return unreachableDetail === undefined
    ? absent(`官方与 Legacy Fabric 都没有 ${gameVersion} 的 loader`)
    : unreachable(unreachableDetail)
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
  const chosen = stable ?? list[0]
  if (chosen === undefined) throw new Error(`Fabric 没有 ${gameVersion} 的 loader`)
  return chosen.loader.version
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

/** 兼容 re-export：实现与文档都在 `core/version/maven.ts`。 */
export { mavenCoordToPath } from '../version/maven.js'

/**
 * 取仓库侧的 .sha1。
 *
 * `candidates` 是「这个文件的候选地址列表」——与下载器同源的镜像规则
 * （direct 永远在最后兜底）。此前只试官方地址，结果 NeoForge 被墙时
 * sha1 探测先死，镜像还没机会上场：下载器走 forgecdn，探测却卡在官方域。
 *
 * 返回三态：所有候选都 404 / 内容不是 sha1 才是 `absent`（没有哈希，
 * 按 ADR-0005 不下载）；任何候选连不上、429、5xx 都算 `unreachable`，
 * 调用方要报网络错误，而不是「取不到哈希」。
 */
export async function fetchMavenSha1(
  url: string,
  opts?: {
    readonly signal?: AbortSignal
    /** 候选地址。缺省就只试官方 */
    readonly candidates?: readonly string[]
  },
): Promise<Probe<string>> {
  const candidates = opts?.candidates ?? [`${url}.sha1`]
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS)
  const signal = AbortSignal.any([
    ...(opts?.signal === undefined ? [] : [opts.signal]),
    timeoutSignal,
  ])
  let unreachableDetail: string | undefined

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': USER_AGENT }, signal })
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          unreachableDetail ??= `${candidate} -> HTTP ${res.status}`
        }
        continue
      }
      const text = (await res.text()).trim().split(/\s+/)[0] ?? ''
      if (/^[0-9a-f]{40}$/i.test(text)) return found(text.toLowerCase())
      // 200 但不是 sha1（镜像错误页）：这个候选没有可用哈希，继续下一个
    } catch (err) {
      if (opts?.signal?.aborted === true) throw err
      unreachableDetail ??= errMessage(err)
    }
  }

  return unreachableDetail === undefined ? absent() : unreachable(unreachableDetail)
}
