import type { ModDependency, ModLoaderKind } from '../modmeta/types.js'
import { depKey, NON_MOD_DEPENDENCY_IDS } from '../modmeta/types.js'
import { compareVersions, satisfiesRange } from '../semver.js'
import type { RangeDialect } from '../semver.js'

export interface LocalDepInput {
  readonly modId: string
  /** 这个模组自己的版本。没给就没法做版本比较 */
  readonly version?: string
  readonly dependencies: readonly ModDependency[]
  /** 这个模组额外提供的 modId（Fabric API 的子模块） */
  readonly provides?: readonly string[]
  /** jar-in-jar 里的嵌套模组 */
  readonly nested?: readonly { readonly modId: string; readonly version: string }[]
  /** 决定版本区间的读法：Forge 的裸版本号不构成限制 */
  readonly loader?: ModLoaderKind
}

/** 实例的运行环境版本，用来校验 `minecraft` / `fabricloader` 这类虚拟依赖 */
export interface LocalDepContext {
  readonly gameVersion?: string
  readonly loaderVersion?: string
  /** 读不出 loader 时的兜底方言 */
  readonly dialect?: RangeDialect
}

function dialectOf(loader: ModLoaderKind | undefined, fallback: RangeDialect): RangeDialect {
  if (loader === 'forge' || loader === 'neoforge') return 'forge'
  if (loader === 'fabric' || loader === 'quilt') return 'fabric'
  return fallback
}

/**
 * 同一个 modId 有多份副本时，哪一份说话。
 *
 * 规则与 Fabric loader 一致：**顶层 jar 优先于 jar-in-jar，同层取最高版本**。
 * 取「最后读到的那一份」会让 BlockPilot 采信某个无关模组 JiJ 里的旧副本，
 * 于是 Create 要求 `flywheel >=1.0.5` 而本地「实际是 1.0.2」——Prominence II
 * 这种 696 个模组的大包整包被判 BLOCKED，实际却能进游戏。
 */
class VersionIndex {
  private readonly top = new Map<string, string | undefined>()
  private readonly nested = new Map<string, string | undefined>()

  constructor(private readonly key: (id: string) => string) {}

  add(id: string, version: string | undefined, fromNested: boolean): void {
    const bucket = fromNested ? this.nested : this.top
    const k = this.key(id)
    if (!bucket.has(k)) {
      bucket.set(k, version)
      return
    }
    const existing = bucket.get(k)
    if (version === undefined) return
    if (existing === undefined) {
      bucket.set(k, version)
      return
    }
    const cmp = compareVersions(version, existing)
    // 看不懂的写法（`1.0.0-beta+build`）不参与排序，保留先到的那份
    if (cmp !== null && cmp > 0) bucket.set(k, version)
  }

  get(id: string): { readonly found: boolean; readonly version?: string } {
    const k = this.key(id)
    if (this.top.has(k)) return { found: true, version: this.top.get(k) }
    if (this.nested.has(k)) return { found: true, version: this.nested.get(k) }
    return { found: false }
  }
}

export type LocalDepIssueKind = 'missing' | 'version'

export interface LocalDepIssue {
  readonly modId: string
  readonly requiredBy: readonly string[]
  readonly kind: LocalDepIssueKind
  /** kind === 'version' 时有值 */
  readonly requiredRange?: string
  readonly actualVersion?: string
}

/**
 * 离线依赖检查。
 *
 * 「在不在」只能查一层——缺失的模组没有 jar，读不到它自己的依赖，没法递归。
 * 想递归就必须联网反查，那是 closure.ts 的活。
 *
 * 但**版本**能查：装了 fabric-api 就能读它的版本号，和依赖方声明的范围比对。
 * 这是 `HARD_DEP`（loader 太旧、mod 版本不符合要求）能在启动前发现的关键。
 *
 * 注意 provides：Fabric API 用一个 jar 声明了十几个子模块 id，
 * 不把它们算作「已提供」会导致满屏假阳性。
 */
export function checkLocalDeps(
  mods: readonly LocalDepInput[],
  ctx: LocalDepContext = {},
): readonly LocalDepIssue[] {
  /** 大小写与下划线/连字符都不敏感：Fabric 写 fabric-api，Forge 写 fabric_api */
  const key = depKey
  const index = new VersionIndex(key)
  const fallbackDialect = ctx.dialect ?? 'any'

  for (const m of mods) {
    index.add(m.modId, m.version, false)
    for (const p of m.provides ?? []) index.add(p, m.version, false)
  }
  // 嵌套模组放在第二轮：顶层 jar 里已经有同名模组时，JiJ 里的旧副本不作数
  for (const m of mods) {
    for (const n of m.nested ?? []) index.add(n.modId, n.version, true)
  }

  const missing = new Map<string, Set<string>>()
  const mismatched = new Map<string, { by: Set<string>; range: string; actual: string }>()

  for (const mod of mods) {
    // 区间是「声明方」写的，所以读法跟着声明方的加载器走
    const dialect = dialectOf(mod.loader, fallbackDialect)
    for (const dep of mod.dependencies) {
      if (!dep.mandatory) continue
      const depId = key(dep.modId)

      // 虚拟 id 不查「在不在」，查「版本够不够」
      if (NON_MOD_DEPENDENCY_IDS.has(depId)) {
        if (dep.versionRange === undefined) continue
        const actual =
          depId === 'minecraft'
            ? ctx.gameVersion
            : depId === 'fabricloader' || depId === 'quilt-loader'
              ? ctx.loaderVersion
              : undefined
        if (actual === undefined) continue
        if (satisfiesRange(actual, dep.versionRange, dialect) !== 'violated') continue
        const entry = mismatched.get(depId)
        if (entry === undefined) {
          mismatched.set(depId, { by: new Set([mod.modId]), range: dep.versionRange, actual })
        } else {
          entry.by.add(mod.modId)
        }
        continue
      }

      const found = index.get(depId)
      if (!found.found) {
        let set = missing.get(depId)
        if (set === undefined) {
          set = new Set()
          missing.set(depId, set)
        }
        set.add(mod.modId)
        continue
      }

      const existing = found.version
      if (dep.versionRange === undefined || existing === undefined) continue
      if (satisfiesRange(existing, dep.versionRange, dialect) !== 'violated') continue
      const entry = mismatched.get(depId)
      if (entry === undefined) {
        mismatched.set(depId, {
          by: new Set([mod.modId]),
          range: dep.versionRange,
          actual: existing,
        })
      } else {
        entry.by.add(mod.modId)
      }
    }
  }

  const issues: LocalDepIssue[] = []
  for (const [modId, by] of missing) {
    issues.push({ modId, requiredBy: [...by], kind: 'missing' })
  }
  for (const [modId, info] of mismatched) {
    issues.push({
      modId,
      requiredBy: [...info.by],
      kind: 'version',
      requiredRange: info.range,
      actualVersion: info.actual,
    })
  }
  return issues
}
