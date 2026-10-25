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

/** 兼容旧调用 */
export function forgeVersionId(gameVersion: string, forgeVersion: string): string {
  return installerSpec('forge', gameVersion, forgeVersion).versionId
}

/** 兼容旧调用 */
export function installerUrl(gameVersion: string, forgeVersion: string): string {
  return installerSpec('forge', gameVersion, forgeVersion).url
}

export interface ForgePromotions {
  readonly [key: string]: string
}

/**
 * 查某个 MC 版本推荐的 Forge 版本。
 *
 * promotions_slim.json 的 key 形如 `1.20.1-recommended` / `1.20.1-latest`。
 * 这个接口偶尔不可用，所以调用方要能接受 null 并回退到用户指定的版本。
 */
export async function recommendedForge(
  gameVersion: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(PROMOTIONS, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(TIMEOUT_MS),
      ]),
    })
    if (!res.ok) return null
    const raw = (await res.json()) as { promos?: Record<string, string> }
    const promos = raw.promos ?? {}
    return promos[`${gameVersion}-recommended`] ?? promos[`${gameVersion}-latest`] ?? null
  } catch {
    return null
  }
}
