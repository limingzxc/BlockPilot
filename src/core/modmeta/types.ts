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
}

/**
 * 这些不是模组，是运行环境的虚拟 id。本地依赖检查必须排除它们，
 * 否则每个模组都会报「缺 minecraft」。
 */
export const NON_MOD_DEPENDENCY_IDS: ReadonlySet<string> = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'forge',
  'neoforge',
  'quilt_loader',
  'quilt-loader',
])
