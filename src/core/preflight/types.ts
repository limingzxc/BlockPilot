/** 预检的输出契约。见 ADR-0002。 */

import type { RepairPlan } from '../deps/plan.js'
import type { LoaderKind } from '../instance.js'

export type Severity = 'blocker' | 'warning' | 'info'

/**
 * 全部合法的 Finding 机器码。
 *
 * `code` 是 LLM 的解释锚点、也是测试的断言对象，所以它不能是裸 `string`：
 * 拼错一个码应该在编译期就红。新增结论必须先登记，
 * `docs/finding-codes.md` 也由这张表校验。
 */
export const FINDING_CODES = [
  'ASSETS_MISSING',
  'CF_NO_MOD_CHECK',
  'CLOSURE_TRUNCATED',
  'CORRUPT_JAR',
  'DECLARED_INCOMPATIBLE',
  'DEPENDENCY_CYCLE',
  'DEPENDENCY_VERSION_MISMATCH',
  'DUPLICATE_MOD',
  'JAVA_INCOMPATIBLE_WITH_MOD',
  'JAVA_MISSING',
  'JAVA_NEWER_ONLY',
  'JAVA_OLDER_PRESENT',
  'JAVA_TOO_NEW',
  'LOADER_MISMATCH',
  'LOW_MEMORY',
  'MISSING_DEPENDENCY',
  'NESTED_ONLY_JAR',
  'PACK_BUILTIN_MODS',
  'SERVER_ONLY_MOD',
  'UNKNOWN_GAME_VERSION',
  'UNREADABLE_JAR',
  'UNRESOLVED_MOD',
  'UNSATISFIABLE_DEPENDENCY',
  'UNVERIFIED_DEPENDENCY',
  'VERSION_MISMATCH',
  'VERSION_UNVERIFIED',
] as const

export type FindingCode = (typeof FINDING_CODES)[number]

/**
 * 每个码的默认级别。`docs/finding-codes.md` 的「默认级别」列由
 * `codes.test.ts` 与这张表对照，避免文档和代码各说各话。
 *
 * `ASSETS_MISSING` 同时可能是 blocker（1.19+ 一个对象都没有）或 warning
 * （老版本、部分缺失），所以这里只登记最常见的那一档，测试按「包含」判断。
 */
export const FINDING_DEFAULT_SEVERITY: Readonly<Record<FindingCode, Severity>> = {
  ASSETS_MISSING: 'blocker',
  CF_NO_MOD_CHECK: 'warning',
  CLOSURE_TRUNCATED: 'warning',
  CORRUPT_JAR: 'warning',
  DECLARED_INCOMPATIBLE: 'blocker',
  DEPENDENCY_CYCLE: 'warning',
  DEPENDENCY_VERSION_MISMATCH: 'blocker',
  DUPLICATE_MOD: 'blocker',
  JAVA_INCOMPATIBLE_WITH_MOD: 'blocker',
  JAVA_MISSING: 'blocker',
  JAVA_NEWER_ONLY: 'warning',
  JAVA_OLDER_PRESENT: 'info',
  JAVA_TOO_NEW: 'blocker',
  LOADER_MISMATCH: 'warning',
  LOW_MEMORY: 'warning',
  MISSING_DEPENDENCY: 'blocker',
  NESTED_ONLY_JAR: 'info',
  PACK_BUILTIN_MODS: 'info',
  SERVER_ONLY_MOD: 'warning',
  UNKNOWN_GAME_VERSION: 'warning',
  UNREADABLE_JAR: 'info',
  UNRESOLVED_MOD: 'info',
  UNSATISFIABLE_DEPENDENCY: 'blocker',
  UNVERIFIED_DEPENDENCY: 'warning',
  VERSION_MISMATCH: 'blocker',
  VERSION_UNVERIFIED: 'warning',
}

export interface Finding {
  readonly severity: Severity
  /** 稳定的机器码。文案可以改，code 不能改——它是 LLM 的解释锚点，也是回归测试的断言对象。 */
  readonly code: FindingCode
  readonly message: string
  /** 出问题的模组 projectId 或文件名 */
  readonly subject?: string
  /** 建议动作 */
  readonly hint?: string
  /**
   * 结构化字段。
   *
   * `message` 是给人读的整句，AI 客户端想拿「谁缺谁」只能解析文本。
   * core 只出 code + 参数，文案渲染留给消费者，也为 i18n 留了位置。
   * 不要求每个 finding 都填——先把有明确字段的补上。
   */
  readonly data?: Readonly<Record<string, unknown>>
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
  /**
   * 检查对象声明的 MC 版本与加载器。
   *
   * CurseForge 包里 mod 级校验做不了，但这两个字段一直读得到——不显示的话，
   * 那句「可以先跑 preflight 看 MC 版本与加载器」就是让用户去看一个不存在的东西。
   */
  readonly target?: {
    readonly gameVersion: string
    readonly loader: { readonly kind: LoaderKind; readonly version: string }
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
