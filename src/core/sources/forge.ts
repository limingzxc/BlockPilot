import { USER_AGENT } from '../user-agent.js'

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const PROMOTIONS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
const TIMEOUT_MS = 20_000

/** Forge 的版本目录名，形如 `1.20.1-forge-47.2.0` */
export function forgeVersionId(gameVersion: string, forgeVersion: string): string {
  return `${gameVersion}-forge-${forgeVersion}`
}

/**
 * installer 的 maven 坐标：`{mc}-{forge}/forge-{mc}-{forge}-installer.jar`
 *
 * 注意 Forge 的版本号不带 MC 前缀（如 `47.2.0`），而目录名带（`1.20.1-47.2.0`）。
 * 这是两套写法，混用会 404。
 */
export function installerUrl(gameVersion: string, forgeVersion: string): string {
  const full = `${gameVersion}-${forgeVersion}`
  return `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`
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
