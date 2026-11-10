/**
 * Quilt 的 loader 元数据。
 *
 * 结构与 Fabric 几乎一致（loader 列表 + profile JSON），但 base 与 maven 不同：
 * - 列表：`/v3/versions/loader/<mc>`，返回 `{ loader: { version } }[]`
 * - profile：`/v3/versions/loader/<mc>/<loader>/profile/json`
 *
 * Quilt 没有 `stable` 标志，也不保证列表有序（实测 1.20.1 的 310 条里
 * 0.20.0-beta.9 排在 0.29.2-beta.4 前面）。所以「最新」要自己按版本号取最大值，
 * 不能拿 `list[0]`。
 */
import { errMessage } from '../errors.js'
import { fetchJson, HttpError } from '../http.js'
import type { Probe } from '../probe.js'
import { absent, found, probeHttpFailure, unreachable } from '../probe.js'
import { compareVersions } from '../semver.js'
import type { FabricProfile } from './fabric.js'

const QUILT_META = 'https://meta.quiltmc.org/v3'

interface QuiltLoaderEntry {
  readonly loader?: { readonly version?: string }
}

export function pickQuiltLoaderVersion(versions: readonly string[]): string | undefined {
  const isPrerelease = (v: string): boolean => v.includes('-')
  let best: string | undefined
  for (const v of versions) {
    if (v === '') continue
    if (best === undefined) {
      best = v
      continue
    }
    const cmp = compareVersions(v, best) ?? 0
    // compareVersions 不比较预发布标签：同号时优先无后缀的正式版，
    // 否则结果取决于列表顺序（Quilt 的列表本来就不保证有序）
    if (cmp > 0 || (cmp === 0 && isPrerelease(best) && !isPrerelease(v))) best = v
  }
  return best
}

export async function listQuiltLoaders(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<Probe<readonly string[]>> {
  try {
    const list = await fetchJson<QuiltLoaderEntry[]>(
      `${QUILT_META}/versions/loader/${gameVersion}`,
      signal === undefined ? {} : { signal },
    )
    const versions = list
      .map((e) => e.loader?.version)
      .filter((v): v is string => typeof v === 'string' && v !== '')
    return versions.length === 0 ? absent(`Quilt 没有 ${gameVersion} 的 loader`) : found(versions)
  } catch (err) {
    if (signal?.aborted === true) throw err
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return absent(`Quilt 没有 ${gameVersion} 的 loader（HTTP ${err.status}）`)
    }
    return unreachable(errMessage(err))
  }
}

export async function fetchQuiltProfile(
  gameVersion: string,
  loaderVersion: string,
  signal?: AbortSignal,
): Promise<Probe<FabricProfile>> {
  try {
    const profile = await fetchJson<FabricProfile>(
      `${QUILT_META}/versions/loader/${gameVersion}/${loaderVersion}/profile/json`,
      signal === undefined ? {} : { signal },
    )
    if (typeof profile.id !== 'string' || !Array.isArray(profile.libraries)) {
      return absent('Quilt 返回的 profile 缺少 id 或 libraries')
    }
    return found(profile)
  } catch (err) {
    if (signal?.aborted === true) throw err
    if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return probeHttpFailure(err.status)
    }
    return unreachable(errMessage(err))
  }
}
