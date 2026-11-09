/**
 * Source 适配接口。
 *
 * 存在的理由（ADR-0001）：@xmcl 的包可能停更，业务层不能直接依赖它。
 * 换实现只改 src/sources/ 下的一个文件，core 一行不动。
 */

export type DependencyKind = 'required' | 'optional' | 'incompatible' | 'embedded'

export interface VersionFile {
  readonly url: string
  readonly filename: string
  readonly size: number
  readonly primary: boolean
  readonly hashes: Readonly<Record<string, string>>
}

export interface DependencyRef {
  readonly projectId: string | null
  readonly versionId: string | null
  readonly kind: DependencyKind
}

export interface VersionInfo {
  readonly projectId: string
  readonly versionId: string
  readonly name: string
  readonly projectSlug?: string
  readonly gameVersions: readonly string[]
  readonly loaders: readonly string[]
  readonly dependencies: readonly DependencyRef[]
  readonly files: readonly VersionFile[]
}

export interface ContentSource {
  readonly name: string
  /** 批量取版本元数据。实现方负责节流与重试。 */
  getVersions(versionIds: readonly string[], signal: AbortSignal): Promise<readonly VersionInfo[]>
}

/** 解析缺失依赖时用的过滤条件。 */
export interface DepFilter {
  readonly gameVersion: string
  /** null 表示 vanilla，不需要过滤 loaders。 */
  readonly loader: string | null
}

/**
 * 反查能力：给定 projectId，找出一个兼容当前实例的版本。
 *
 * 依赖闭包必须要有它——实例里只装了 A，A 依赖 B，B 又依赖 C，
 * 而 B 和 C 都不在实例里，只能靠 projectId 反查才能继续往下走。
 */
export interface DependencyResolver {
  resolve(projectId: string, filter: DepFilter, signal: AbortSignal): Promise<VersionInfo | null>
}

/**
 * 可选能力：把 projectId 翻成用户看得懂的名字（Modrinth 的 project title）。
 *
 * 依赖闭包只能拿到 id——缺的那个依赖在实例里没有 jar，元数据里也只有 projectId。
 * 只给 id 的提示用户无法处理：「TIo1UXXV 需要前置模组 ordsPcFz」既不知道是谁，
 * 也不知道该去搜什么。名字只影响文案，不影响判定，所以拿不到时静默降级。
 */
export interface ProjectNamer {
  getProjectNames(
    projectIds: readonly string[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, string>>
}
