/**
 * 依赖闭包结果 → findings。
 *
 * 判定在 deps（闭包本身），文案与机器码在 preflight。把这个映射放在 preflight，
 * deps 就不再反向依赖预检的类型；`deps → preflight` 的反向边也随之消失。
 */

import type { ClosureResult } from '../deps/closure.js'
import type { Finding } from './types.js'

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
        data: { projectId: m.projectId, requiredBy: m.requiredBy },
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
        data: { projectId: m.projectId, requiredBy: m.requiredBy },
        hint: `可安装 ${m.resolved.name}`,
      })
    } else {
      out.push({
        severity: 'blocker',
        code: 'UNSATISFIABLE_DEPENDENCY',
        message: `${by}${more} 需要前置模组 ${label(m.projectId)}，但找不到兼容当前游戏版本与加载器的版本`,
        subject: m.projectId,
        data: { projectId: m.projectId, requiredBy: m.requiredBy },
        hint: '需要降级游戏版本、更换加载器，或找替代模组',
      })
    }
  }

  for (const cycle of result.cycles) {
    out.push({
      severity: 'warning',
      code: 'DEPENDENCY_CYCLE',
      message: `检测到循环依赖：${cycle.join(' → ')}`,
      ...(cycle[0] === undefined ? {} : { subject: cycle[0] }),
      hint: '多数加载器能容忍这种声明，但它通常意味着模组元数据有误',
    })
  }

  if (result.truncated) {
    out.push({
      // warning 而不是 info：ADR-0003 明确「截断时不允许说 ok」
      severity: 'warning',
      code: 'CLOSURE_TRUNCATED',
      message: '依赖链超出展开上限，已停止递归',
      hint: '缺失项列表可能不完整，不能据此判断实例是干净的',
    })
  }

  return out
}
