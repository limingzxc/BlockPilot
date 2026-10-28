import { fetchJson } from '../http.js'
import type { VersionJson, VersionManifest } from './types.js'

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
/** BMCLAPI 的前缀替换规则：同路径换 host */
const BMCLAPI_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'

export interface VersionFetchOptions {
  /** true 时走 BMCLAPI（国内更快） */
  readonly mirror?: boolean
  readonly signal?: AbortSignal
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(url, signal === undefined ? {} : { signal })
}

export async function fetchManifest(opts: VersionFetchOptions = {}): Promise<VersionManifest> {
  return getJson<VersionManifest>(opts.mirror === true ? BMCLAPI_MANIFEST : MOJANG_MANIFEST, opts.signal)
}

/** 拉某个版本的完整 JSON。manifest 里的 url 可能指向 BMCLAPI 或 Mojang，都能直接用。 */
export async function fetchVersionJson(
  versionId: string,
  opts: VersionFetchOptions = {},
): Promise<VersionJson> {
  const manifest = await fetchManifest(opts)
  const entry = manifest.versions.find((v) => v.id === versionId)
  if (entry === undefined) {
    throw new Error(`版本不存在：${versionId}`)
  }
  return getJson<VersionJson>(entry.url, opts.signal)
}
