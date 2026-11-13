import type { DependencyResolver, DepFilter, VersionInfo } from '../content-source.js'

export interface MissingDep {
  readonly projectId: string
  readonly requiredBy: readonly string[]
  /** null 表示找不到兼容版本——这个依赖无法自动满足 */
  readonly resolved: VersionInfo | null
}

export interface ClosureResult {
  /** 展开过的 projectId，按发现顺序 */
  readonly visited: readonly string[]
  readonly missing: readonly MissingDep[]
  readonly cycles: readonly (readonly string[])[]
  /** 触到节点上限，报告不完整 */
  readonly truncated: boolean
}

export interface ClosureOptions {
  /** 实例里已存在且已解析的模组 */
  readonly roots: readonly VersionInfo[]
  readonly filter: DepFilter
  readonly resolver: DependencyResolver
  readonly signal: AbortSignal
  /** 最多反查多少个缺失 project。真实整合包通常个位数，200 是防御性上限 */
  readonly maxResolves?: number
}

/**
 * 依赖闭包：从实例里的模组出发，沿 required 依赖递归展开。
 *
 * 关键约束：实例里**已存在**的模组不再反查——它们自己就在 roots 里，会被独立展开。
 * 只有「实例里没有的」才需要 resolver 去问内容源。
 *
 * 本函数不判断版本约束是否冲突（Modrinth 的依赖元数据里根本没有版本范围），
 * 同一 projectId 只解析一次，取内容源返回的最新兼容版本。
 */
export async function computeClosure(opts: ClosureOptions): Promise<ClosureResult> {
  const { roots, filter, resolver, signal, maxResolves = 200 } = opts

  const installed = new Set(roots.map((r) => r.projectId))
  const expanded = new Set<string>()
  const missing = new Map<string, { requiredBy: Set<string>; resolved: VersionInfo | null }>()
  const cycles: string[][] = []
  let truncated = false

  interface Frame {
    readonly info: VersionInfo
    readonly path: readonly string[]
  }

  const queue: Frame[] = roots.map((info) => ({ info, path: [info.projectId] }))

  while (queue.length > 0) {
    if (signal.aborted) break
    const frame = queue.shift()
    if (frame === undefined) break
    const { info, path } = frame

    if (expanded.has(info.projectId)) continue
    expanded.add(info.projectId)

    for (const dep of info.dependencies) {
      if (dep.kind !== 'required') continue
      const target = dep.projectId
      if (target === null) continue

      if (installed.has(target)) continue
      if (path.includes(target)) {
        cycles.push([...path, target])
        continue
      }

      let entry = missing.get(target)
      if (entry === undefined) {
        if (missing.size >= maxResolves) {
          truncated = true
          continue
        }
        const resolved = await resolver.resolve(target, filter, signal)
        entry = { requiredBy: new Set<string>(), resolved }
        missing.set(target, entry)
        if (resolved !== null) {
          queue.push({ info: resolved, path: [...path, target] })
        }
      }
      entry.requiredBy.add(info.projectId)
    }
  }

  return {
    visited: [...expanded],
    missing: [...missing.entries()].map(([projectId, v]) => ({
      projectId,
      requiredBy: [...v.requiredBy],
      resolved: v.resolved,
    })),
    cycles,
    truncated,
  }
}
