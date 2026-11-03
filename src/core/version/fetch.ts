import { fetchJson } from '../http.js'
import type { VersionJson, VersionManifest } from './types.js'

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** BMCLAPI 的前缀替换规则：同路径换 host */
const BMCLAPI_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'

export interface VersionFetchOptions {
  /** true 时**优先**走 BMCLAPI（国内更快），失败仍退回官方 */
  readonly mirror?: boolean
  readonly signal?: AbortSignal
}

/**
 * 版本 id 在 manifest 里找不到。
 *
 * 单独一个类型只是为了给 CLI 一个稳定错误码：「你给的名字不存在」是最常见的
 * 失败之一（少跑一次 deploy、抄错版本号），不该显示成 `unexpected error: Error: ...`。
 */
export class VersionNotFoundError extends Error {
  constructor(readonly versionId: string) {
    super(`版本不存在：${versionId}`)
    this.name = 'VersionNotFoundError'
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(url, signal === undefined ? {} : { signal })
}

export async function fetchManifest(opts: VersionFetchOptions = {}): Promise<VersionManifest> {
  if (opts.mirror !== true) return getJson<VersionManifest>(MOJANG_MANIFEST, opts.signal)

  // `--china` 的语义是「镜像优先」，不是「只用镜像」。
  // 以前这里是二选一，镜像一挂（或用户网络对它的 302 链不友好）整条路就断，
  // 而下载那边 chinaFirstSources() 一直是有直连兜底的——两边得一致。
  try {
    return await getJson<VersionManifest>(BMCLAPI_MANIFEST, opts.signal)
  } catch (err) {
    // 用户主动取消不该触发回退：那会让 Ctrl+C 变成一次新的请求
    if (opts.signal?.aborted === true) throw err
    return getJson<VersionManifest>(MOJANG_MANIFEST, opts.signal)
  }
}

/** 拉某个版本的完整 JSON。manifest 里的 url 可能指向 BMCLAPI 或 Mojang，都能直接用。 */
export async function fetchVersionJson(
  versionId: string,
  opts: VersionFetchOptions = {},
): Promise<VersionJson> {
  const manifest = await fetchManifest(opts)
  const entry = manifest.versions.find((v) => v.id === versionId)
  if (entry === undefined) {
    throw new VersionNotFoundError(versionId)
  }

  try {
    return await getJson<VersionJson>(entry.url, opts.signal)
  } catch (err) {
    if (opts.mirror !== true || opts.signal?.aborted === true) throw err
    // 镜像给的 url 也可能是镜像域。改用官方 manifest 里的同名条目再试一次，
    // 否则「manifest 回退成功、单版本回退没有」这种半吊子状态最难查。
    const official = await fetchManifest({ ...opts, mirror: false })
    const fallback = official.versions.find((v) => v.id === versionId)
    if (fallback === undefined) throw err
    return getJson<VersionJson>(fallback.url, opts.signal)
  }
}
