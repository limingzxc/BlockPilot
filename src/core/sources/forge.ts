import { errMessage } from '../errors.js'
import type { Probe } from '../probe.js'
import { absent, found, probeHttpFailure, unreachable } from '../probe.js'
import { compareVersions } from '../semver.js'
import { USER_AGENT } from '../user-agent.js'

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge'
const PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const TIMEOUT_MS = 20_000

export type InstallerKind = 'forge' | 'neoforge'

export interface InstallerSpec {
  readonly url: string
  /** 安装后 versions/ 下的目录名 */
  readonly versionId: string
}

/**
 * Forge 与 NeoForge 的坐标规则不同，不能混用：
 *
 * | | maven 路径 | 版本目录名 |
 * |---|---|---|
 * | Forge | `{mc}-{forge}/forge-{mc}-{forge}-installer.jar` | `{mc}-forge-{forge}` |
 * | NeoForge | `{neo}/neoforge-{neo}-installer.jar` | `neoforge-{neo}` |
 *
 * 注意 NeoForge 的版本号**不带 MC 前缀**（`21.1.66` 对应 MC 1.21.1），
 * 而 Forge 的目录名**带**（`1.20.1-47.2.0`）。
 */
export function installerSpec(
  kind: InstallerKind,
  gameVersion: string,
  loaderVersion: string,
): InstallerSpec {
  if (kind === 'neoforge') {
    return {
      url: `${NEOFORGE_MAVEN}/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`,
      versionId: `neoforge-${loaderVersion}`,
    }
  }
  const full = `${gameVersion}-${loaderVersion}`
  return {
    url: `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`,
    versionId: `${gameVersion}-forge-${loaderVersion}`,
  }
}

export interface ForgePromotions {
  readonly [key: string]: string
}

/**
 * 查某个 MC 版本推荐的 Forge 版本。
 *
 * promotions_slim.json 的 key 形如 `1.20.1-recommended` / `1.20.1-latest`。
 * 返回三态：`absent` 表示这份清单里确实没有该版本，`unreachable` 表示没连上——
 * 后者不该被报成「查不到推荐版本」，否则用户会去手填版本而不是查网络。
 */
/**
 * MC 版本 → NeoForge 版本前缀。
 *
 * NeoForge 的版本号是 `20.4.x` / `21.1.x`：前两段对应 MC 的 minor/patch。
 * 1.20.1 没有 NeoForge（那时还是 Forge），返回 null。
 */
export function neoforgePrefix(gameVersion: string): string | null {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(gameVersion)
  if (m === null) return null
  const minor = Number(m[1])
  const patch = m[2] === undefined ? 0 : Number(m[2])
  if (minor === 20) return patch >= 2 ? `20.${patch}` : null
  if (minor >= 21) return `21.${patch}`
  return null
}

/**
 * NeoForge 没有 Forge 那种 promotions 文件，直接从 maven-metadata 里挑。
 *
 * 同一 MC 版本的前缀下会有几十个构建；按 semver 取最大，不能拿 XML 里
 * 的最后一个（构建发布顺序不等于版本顺序）。
 */
export async function recommendedNeoForge(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<Probe<string>> {
  const prefix = neoforgePrefix(gameVersion)
  if (prefix === null) return absent(`NeoForge 不支持 MC ${gameVersion}`)
  const url = `${NEOFORGE_MAVEN}/maven-metadata.xml`
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml' },
      signal: AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(TIMEOUT_MS),
      ]),
    })
    if (!res.ok) return probeHttpFailure(res.status)
    const text = await res.text()
    const versions = [...text.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined && v.startsWith(`${prefix}.`))
    if (versions.length === 0) return absent(`NeoForge 没有 ${gameVersion} 的构建`)
    let best: string | undefined
    for (const v of versions) {
      if (best === undefined || (compareVersions(v, best) ?? 0) > 0) best = v
    }
    return best === undefined ? absent(`NeoForge 没有 ${gameVersion} 的构建`) : found(best)
  } catch (err) {
    if (signal?.aborted === true) throw err
    return unreachable(errMessage(err))
  }
}

export async function recommendedForge(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<Probe<string>> {
  try {
    const res = await fetch(PROMOTIONS, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(TIMEOUT_MS),
      ]),
    })
    if (!res.ok) return probeHttpFailure(res.status)
    const raw = (await res.json()) as { promos?: Record<string, string> }
    const promos = raw.promos ?? {}
    const version = promos[`${gameVersion}-recommended`] ?? promos[`${gameVersion}-latest`]
    return version === undefined
      ? absent(`promotions 里没有 ${gameVersion} 的条目`)
      : found(version)
  } catch (err) {
    if (signal?.aborted === true) throw err
    return unreachable(errMessage(err))
  }
}
