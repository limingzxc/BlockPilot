/** Forge / NeoForge 的 META-INF/mods.toml 与 neoforge.mods.toml。 */

import { parse as parseToml } from 'smol-toml'

import { normDep } from './deps.js'
import type { ModDependency, ModLoaderKind, ModMetadata } from './types.js'

type TomlShape = {
  modLoader?: string
  loaderVersion?: string
  mods?: Array<{
    modId?: string
    version?: string
    displayName?: string
    provides?: unknown
  }>
  dependencies?: Record<
    string,
    Array<{
      modId?: string
      /** 1.13–1.20.4 的写法 */
      mandatory?: boolean
      /**
       * NeoForge 1.20.5+ 改用 `type = "required|optional|incompatible"`，
       * 不再写 `mandatory`。不认它会把可选依赖当成必需，报出假的 MISSING_DEPENDENCY。
       */
      type?: string
      versionRange?: string
    }>
  >
}

export function fromForgeToml(text: string, loader: ModLoaderKind): ModMetadata | null {
  let raw: TomlShape
  try {
    raw = parseToml(text) as TomlShape
  } catch {
    return null
  }
  const mods = raw.mods ?? []
  const first = mods[0]
  if (first === undefined || typeof first.modId !== 'string') return null

  /**
   * 一个 jar 可以声明多个 `[[mods]]`（常见于前置打包）。只读 `[0]` 会让后面那些
   * modId 的依赖永远匹配不上，报出假的 MISSING_DEPENDENCY。
   */
  const declaredIds = mods
    .map((m) => m.modId)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  const depsRaw = mods.flatMap((m) =>
    typeof m.modId === 'string' ? (raw.dependencies?.[m.modId] ?? []) : [],
  )
  const deps: ModDependency[] = []
  const seen = new Set<string>()
  for (const d of depsRaw) {
    if (typeof d.modId !== 'string') continue
    const key = `${d.modId}|${d.versionRange ?? ''}|${d.type ?? ''}|${String(d.mandatory)}`
    if (seen.has(key)) continue
    seen.add(key)
    /**
     * `mandatory` 优先（老写法显式给了就以它为准）；否则看 `type`。
     * `incompatible` 不是「必需」，不能因为它不在实例里就报缺依赖。
     */
    const mandatory =
      d.mandatory !== undefined
        ? d.mandatory
        : d.type === undefined
          ? true
          : d.type.toLowerCase() === 'required'
    deps.push(
      normDep(
        d.modId,
        mandatory,
        d.versionRange,
        d.type?.toLowerCase() === 'incompatible' ? 'breaks' : undefined,
      ),
    )
  }

  const mc = deps.find((d) => d.modId === 'minecraft')
  const fl = deps.find((d) => d.modId === 'forge' || d.modId === 'neoforge')

  /**
   * NeoForge 1.20.2–1.20.4 仍然用 `META-INF/mods.toml`。
   *
   * 只看文件名会把它标成 forge，NeoForge 实例里这些模组全部进 ignored：
   * 既误报 LOADER_MISMATCH，又失去依赖检查。这一段 NeoForge 模组的依赖里写
   * `modId="neoforge"`，Forge 模组写 `modId="forge"`——两边都有（兼容包）时
   * 保持 forge，避免在 Forge 实例上反过来误判。
   */
  const resolvedLoader: ModLoaderKind =
    loader === 'forge' &&
    deps.some((d) => d.modId === 'neoforge') &&
    !deps.some((d) => d.modId === 'forge')
      ? 'neoforge'
      : loader

  /**
   * Forge 的 `[[mods]]` 也有 `provides`，只是**必须加引号写成数组**：
   *
   *   [[mods]]
   *     modId = "fabric_api"
   *     provides = ["fabric", "fabric-api"]
   *
   * 这在 Sinytra Connector 生态里是通行做法——Forgified Fabric API 就靠它
   * 让 `fabric` / `fabric-api` 这些依赖能匹配上 `fabric_api`。
   * 早期版本这里写的是 `provides: []`，注释还写着「Forge 没有 provides 概念」，
   * 那是错的：BMC4（229 万下载）因此整包被判 BLOCKED。
   */
  const provides: string[] = []
  const rawProvides = first.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) if (typeof p === 'string' && p !== '') provides.push(p)
  } else if (typeof rawProvides === 'string' && rawProvides !== '') {
    // 单个字符串也接受（Toml 里写 provides = "x" 的情况）
    provides.push(rawProvides)
  }
  // 同一个 jar 里其余 [[mods]] 的 modId 也算「本 jar 提供了它」
  for (const id of declaredIds.slice(1)) {
    if (!provides.includes(id)) provides.push(id)
  }

  return {
    modId: first.modId,
    version: typeof first.version === 'string' ? first.version : 'unknown',
    ...(first.displayName === undefined ? {} : { name: first.displayName }),
    loader: resolvedLoader,
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    ...(fl?.versionRange === undefined ? {} : { loaderVersionRange: fl.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
  }
}
