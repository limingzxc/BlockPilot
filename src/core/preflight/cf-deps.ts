import type { VersionInfo } from '../content-source.js'
import type { Instance } from '../instance.js'
import type { Finding } from './types.js'

/**
 * CurseForge 包的「声明依赖」检查。
 *
 * 与 Modrinth 的闭包检查有一个本质区别：整合包里没有 jar，无法递归证实。
 * 所以口径跟 ADR-0025 一致——只报 warning，并明说「可能已内置在某个模组里」。
 *
 * 好消息是 CF 的依赖直接给 projectId（modId），和 manifest 里的 projectID 是同一套编号，
 * 所以「装了没装」能直接判，不需要再反查。
 */
export function cfDependencyFindings(
  instance: Instance,
  versions: readonly VersionInfo[],
): readonly Finding[] {
  const present = new Set(
    instance.mods
      .map((m) => m.projectId)
      .filter((id): id is string => id !== undefined && id !== ''),
  )
  const nameOf = new Map(versions.map((v) => [v.projectId, v.name]))

  /** 依赖 projectId → 需要它的模组名 */
  const missing = new Map<string, Set<string>>()
  for (const v of versions) {
    for (const dep of v.dependencies) {
      if (dep.kind !== 'required' || dep.projectId === null) continue
      if (present.has(dep.projectId)) continue
      let set = missing.get(dep.projectId)
      if (set === undefined) {
        set = new Set()
        missing.set(dep.projectId, set)
      }
      set.add(v.name)
    }
  }

  return [...missing].map(([depId, by]) => {
    const names = [...by]
    const shown = names.slice(0, 3).join('、')
    return {
      severity: 'warning' as const,
      code: 'UNVERIFIED_DEPENDENCY',
      message:
        `${shown}${names.length > 3 ? ` 等 ${names.length} 个模组` : ''} 需要前置模组 ` +
        `${nameOf.get(depId) ?? depId}，整合包里没有它（可能已内置在某个模组里）`,
      subject: depId,
      hint: '整合包常把依赖打在 jar-in-jar 里；装完跑一次 preflight <实例目录> 确认，确有缺失再补装',
    }
  })
}
