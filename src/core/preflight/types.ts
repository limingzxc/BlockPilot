/** 预检的输出契约。见 ADR-0002。 */

import type { RepairPlan } from '../deps/plan.js'

export type Severity = 'blocker' | 'warning' | 'info'

export interface Finding {
  readonly severity: Severity
  /** 稳定的机器码。文案可以改，code 不能改——它是 LLM 的解释锚点，也是回归测试的断言对象。 */
  readonly code: string
  readonly message: string
  /** 出问题的模组 projectId 或文件名 */
  readonly subject?: string
  /** 建议动作 */
  readonly hint?: string
}

export type Verdict = 'ok' | 'warn' | 'blocked' | 'unknown'

export interface PreflightReport {
  readonly verdict: Verdict
  readonly findings: readonly Finding[]
  readonly stats: {
    readonly mods: number
    readonly resolved: number
    readonly unresolved: number
  }
  /** 可执行的修复动作。空数组表示没有可自动补装的东西。 */
  readonly plan: RepairPlan
  readonly generatedAt: string
}

export function verdictOf(findings: readonly Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'blocker')) return 'blocked'
  if (findings.some((f) => f.severity === 'warning')) return 'warn'
  return 'ok'
}
