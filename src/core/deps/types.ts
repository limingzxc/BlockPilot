/**
 * 依赖修复计划的输出契约。
 *
 * 这组类型被 preflight 的报告类型引用，而 closure 又依赖 preflight 的 Finding。
 * 类型留在 `plan.ts` 会让 `closure → preflight/types → plan → closure` 成环；
 * 单独放一份纯类型文件，环就断在这里，`plan.ts` 只保留装配函数。
 */

/** 这条安装建议有多确定。见 closure.ts 的 FindingOptions。 */
export type InstallConfidence = 'verified' | 'unverified'

/** 一条可以直接执行的安装动作。字段与下载器需要的完全对齐。 */
export interface PlannedInstall {
  readonly projectId: string
  readonly versionId: string
  readonly displayName: string
  readonly fileName: string
  readonly url: string
  readonly size: number
  /** sha1 / sha512，下载后必须校验 */
  readonly hashes: Readonly<Record<string, string>>
  /** 谁需要它。可能不止一个。 */
  readonly requiredBy: readonly string[]
  /**
   * `unverified`：整合包里没看到它，但也无法排除它被别的模组内置（jar-in-jar）。
   * 默认不装——装重复的模组换不来任何好处，还可能改变整合包作者确定的版本。
   */
  readonly confidence: InstallConfidence
}

export type ManualReason = 'no-compatible-version' | 'no-download-file'

/** 查得到问题、但没法自动修的那部分。 */
export interface ManualFix {
  readonly projectId: string
  readonly reason: ManualReason
  /** 人看得懂的项目名。拿不到就不填，渲染时退回 projectId */
  readonly displayName?: string
}

export interface RepairPlan {
  readonly installs: readonly PlannedInstall[]
  readonly manual: readonly ManualFix[]
}

export interface PlanOptions {
  /** 与 closureToFindings 的 verified 同义：false 时所有安装项标为 unverified */
  readonly verified?: boolean
  /** projectId → 名字，仅用于 manual 项的展示 */
  readonly nameOf?: (projectId: string) => string | undefined
}
