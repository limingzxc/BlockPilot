import type { ModDependency } from '../modmeta/types.js'
import { NON_MOD_DEPENDENCY_IDS } from '../modmeta/types.js'

export interface LocalDepInput {
  readonly modId: string
  readonly dependencies: readonly ModDependency[]
  /** 这个模组额外提供的 modId（Fabric API 的子模块） */
  readonly provides?: readonly string[]
}

export interface LocalDepIssue {
  readonly modId: string
  readonly requiredBy: readonly string[]
}

/**
 * 离线依赖检查。
 *
 * 只能查一层——缺失的模组没有 jar，读不到它自己的依赖，没法递归。
 * 想递归就必须联网反查，那是 closure.ts 的活。
 *
 * 注意 provides：Fabric API 用一个 jar 声明了十几个子模块 id，
 * 不把它们算作「已提供」会导致满屏假阳性。
 */
export function checkLocalDeps(mods: readonly LocalDepInput[]): readonly LocalDepIssue[] {
  const present = new Set<string>()
  for (const m of mods) {
    present.add(m.modId)
    for (const p of m.provides ?? []) present.add(p)
  }
  const missing = new Map<string, Set<string>>()

  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      if (!dep.mandatory) continue
      if (NON_MOD_DEPENDENCY_IDS.has(dep.modId)) continue
      if (present.has(dep.modId)) continue
      let set = missing.get(dep.modId)
      if (set === undefined) {
        set = new Set()
        missing.set(dep.modId, set)
      }
      set.add(mod.modId)
    }
  }

  return [...missing.entries()].map(([modId, by]) => ({
    modId,
    requiredBy: [...by],
  }))
}
