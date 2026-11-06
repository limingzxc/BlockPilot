import type { DepFilter, DependencyResolver, VersionInfo } from '../sources.js'
import type { Finding } from '../preflight/types.js'

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

export interface FindingOptions {
  /**
   * 「缺失」是否有直接证据。
   *
   * 整合包（.mrpack）里没有 jar，无法确认某个依赖是不是被打进了别的模组的
   * `META-INF/jars/`（jar-in-jar）。Modrinth 的元数据也不会标这一点——真实样本：
   * Fabulously Optimized 6.5.0 的 Puzzle / Mod Menu 就是这样带 MidnightLib 与
   * Placeholder API 的，但它俩在依赖里仍然写作 `required`。
   *
   * 所以整合包模式下传 false：缺依赖降级为 warning，措辞改成「可能已内置」。
   * 默认 true（有 jar 可比对时才叫确定缺失）。
   */
  readonly verified?: boolean
  /**
   * projectId → 人看得懂的名字。可选：拿不到时退回裸 id，判定不受影响。
   * 见 ProjectNamer：闭包里只有 id，而「需要前置模组 ordsPcFz」用户没法处理。
   */
  readonly nameOf?: (projectId: string) => string | undefined
}

/** 把闭包结果翻译成 findings。文案给人看，code 给机器用。 */
export function closureToFindings(
  result: ClosureResult,
  opts: FindingOptions = {},
): readonly Finding[] {
  const out: Finding[] = []
  const verified = opts.verified !== false
  /** 有名字就写「名字 (id)」：名字给人看，id 给脚本与搜索用 */
  const label = (projectId: string): string => {
    const name = opts.nameOf?.(projectId)
    return name === undefined || name === '' ? projectId : `${name} (${projectId})`
  }

  for (const m of result.missing) {
    const by = m.requiredBy.slice(0, 3).map(label).join('、')
    const more = m.requiredBy.length > 3 ? ` 等 ${m.requiredBy.length} 个模组` : ''
    if (!verified) {
      out.push({
        severity: 'warning',
        code: 'UNVERIFIED_DEPENDENCY',
        message:
          m.resolved === null
            ? `${by}${more} 需要前置模组 ${label(m.projectId)}，元数据里没有兼容版本（也可能已内置在某个模组里）`
            : `${by}${more} 需要前置模组 ${label(m.projectId)}，整合包里没有它（可能已内置在某个模组里）`,
        subject: m.projectId,
        hint: '整合包常把依赖打在 jar-in-jar 里；装完跑一次 preflight <实例目录> 确认，确有缺失再补装',
      })
      continue
    }
    if (m.resolved !== null) {
      out.push({
        severity: 'blocker',
        code: 'MISSING_DEPENDENCY',
        message: `${by}${more} 需要前置模组 ${label(m.projectId)}，它不在实例中`,
        subject: m.projectId,
        hint: `可安装 ${m.resolved.name}`,
      })
    } else {
      out.push({
        severity: 'blocker',
        code: 'UNSATISFIABLE_DEPENDENCY',
        message: `${by}${more} 需要前置模组 ${label(m.projectId)}，但找不到兼容当前游戏版本与加载器的版本`,
        subject: m.projectId,
        hint: '需要降级游戏版本、更换加载器，或找替代模组',
      })
    }
  }

  for (const cycle of result.cycles) {
    out.push({
      severity: 'warning',
      code: 'DEPENDENCY_CYCLE',
      message: `检测到循环依赖：${cycle.join(' → ')}`,
      subject: cycle[0],
      hint: '多数加载器能容忍这种声明，但它通常意味着模组元数据有误',
    })
  }

  if (result.truncated) {
    out.push({
      severity: 'info',
      code: 'CLOSURE_TRUNCATED',
      message: '依赖链超出展开上限，已停止递归',
      hint: '缺失项列表可能不完整，不能据此判断实例是干净的',
    })
  }

  return out
}
