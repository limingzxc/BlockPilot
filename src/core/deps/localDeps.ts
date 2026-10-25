import type { ModDependency } from '../modmeta/types.js'
import { NON_MOD_DEPENDENCY_IDS } from '../modmeta/types.js'
import { satisfiesRange } from '../semver.js'

export interface LocalDepInput {
  readonly modId: string
  /** 这个模组自己的版本。没给就没法做版本比较 */
  readonly version?: string
  readonly dependencies: readonly ModDependency[]
  /** 这个模组额外提供的 modId（Fabric API 的子模块） */
  readonly provides?: readonly string[]
  /** jar-in-jar 里的嵌套模组 */
  readonly nested?: readonly { readonly modId: string; readonly version: string }[]
}

/** 实例的运行环境版本，用来校验 `minecraft` / `fabricloader` 这类虚拟依赖 */
export interface LocalDepContext {
  readonly gameVersion?: string
  readonly loaderVersion?: string
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
  const present = new Map<string, string | undefined>()
  for (const m of mods) {
    present.set(m.modId, m.version)
    for (const p of m.provides ?? []) present.set(p, m.version)
    for (const n of m.nested ?? []) present.set(n.modId, n.version)
  }

  const missing = new Map<string, Set<string>>()
  const mismatched = new Map<string, { by: Set<string>; range: string; actual: string }>()

  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      if (!dep.mandatory) continue

      // 虚拟 id 不查「在不在」，查「版本够不够」
      if (NON_MOD_DEPENDENCY_IDS.has(dep.modId)) {
        if (dep.versionRange === undefined) continue
        const actual =
          dep.modId === 'minecraft'
            ? ctx.gameVersion
            : dep.modId === 'fabricloader' || dep.modId === 'quilt_loader'
              ? ctx.loaderVersion
              : undefined
        if (actual === undefined) continue
        if (satisfiesRange(actual, dep.versionRange) !== 'violated') continue
        const entry = mismatched.get(dep.modId)
        if (entry === undefined) {
          mismatched.set(dep.modId, { by: new Set([mod.modId]), range: dep.versionRange, actual })
        } else {
          entry.by.add(mod.modId)
        }
        continue
      }

      if (!present.has(dep.modId)) {
        let set = missing.get(dep.modId)
        if (set === undefined) {
          set = new Set()
          missing.set(dep.modId, set)
        }
        set.add(mod.modId)
        continue
      }

      const existing = present.get(dep.modId)
      if (dep.versionRange === undefined || existing === undefined) continue
      if (satisfiesRange(existing, dep.versionRange) !== 'violated') continue
      const entry = mismatched.get(dep.modId)
      if (entry === undefined) {
        mismatched.set(dep.modId, {
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
