/** 从 mod jar 内部读出来的元数据。与在线元数据（Modrinth projectId）是两套身份。 */

export type ModLoaderKind = 'fabric' | 'quilt' | 'neoforge' | 'forge' | 'unknown'

export interface ModDependency {
  /** jar 里声明的 modId，如 fabric-api、flywheel。不是 Modrinth 的 projectId。 */
  readonly modId: string
  readonly mandatory: boolean
  readonly versionRange?: string
}

export interface ModMetadata {
  readonly modId: string
  readonly version: string
  readonly name?: string
  readonly loader: ModLoaderKind
  /** 支持的 MC 版本范围，原样保留（Fabric 是 semver 表达式，Forge 是 Maven range） */
  readonly mcVersionRange?: string
  readonly loaderVersionRange?: string
  readonly dependencies: readonly ModDependency[]
  /**
   * 这个 jar 额外提供的 modId。
   *
   * Fabric API 就靠这个声明子模块（fabric-rendering-fluids-v1 等）——
   * 它们是虚拟 id，没有独立的 jar，但别的模组会依赖它们。
   * 不处理 provides 会导致装了 Fabric API 仍然报「缺 fabric-rendering-fluids-v1」。
   */
  readonly provides: readonly string[]
  /**
   * jar-in-jar 里嵌套的模组（`META-INF/jars/*.jar`）。
   *
   * Fabric API 0.92+ 把 57 个子模块拆成了嵌套 jar，最外层的 fabric.mod.json
   * 并不声明 provides。不读这一层，sodium 这类依赖子模块的模组会被误报缺前置。
   */
  readonly nested: readonly { readonly modId: string; readonly version: string }[]
}

/**
 * 依赖 id 的比较键。
 *
 * 两个生态对同一个东西的拼写不一样：Fabric 写 `fabric-api`，Forge 写 `fabric_api`；
 * 大小写也不统一（mcmod.info 里有写 `ForgeEndertech` 的）。
 * 比较前统一成「小写 + 连字符」，否则 `fabric_api` 永远满足不了 `fabric-api`。
 */
export function depKey(id: string): string {
  return id.toLowerCase().replace(/_/g, '-')
}

/**
 * 这些不是模组，是运行环境的虚拟 id。本地依赖检查必须排除它们，
 * 否则每个模组都会报「缺 minecraft」。
 *
 * 用连字符形式（与 {@link depKey} 的输出一致）。
 */
export const NON_MOD_DEPENDENCY_IDS: ReadonlySet<string> = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'forge',
  // 1.12.2 的 mcmod.info 里，Forge 本身被写成 mod_MinecraftForge（大小写不统一）
  'mod-minecraftforge',
  'neoforge',
  'quilt-loader',
])
