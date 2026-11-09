import type { ClosureResult } from './closure.js'

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

/** 没有可自动补装的东西。报告里用它，避免每个装配点各写一遍 `installs: []`。 */
export const EMPTY_PLAN: RepairPlan = { installs: [], manual: [] }

export interface PlanOptions {
  /** 与 closureToFindings 的 verified 同义：false 时所有安装项标为 unverified */
  readonly verified?: boolean
  /** projectId → 名字，仅用于 manual 项的展示 */
  readonly nameOf?: (projectId: string) => string | undefined
}

/**
 * 把依赖闭包翻译成可执行的安装计划。
 *
 * 只处理「缺依赖」这一类问题——版本不匹配、声明不兼容都不是装一个东西能解决的，
 * 硬塞进 plan 只会让消费者误以为能一键修复。
 */
export function buildRepairPlan(
  closure: ClosureResult,
  opts: PlanOptions = {},
): RepairPlan {
  const installs: PlannedInstall[] = []
  const manual: ManualFix[] = []
  const confidence: InstallConfidence = opts.verified === false ? 'unverified' : 'verified'

  for (const dep of closure.missing) {
    const version = dep.resolved
    const displayName = opts.nameOf?.(dep.projectId)
    if (version === null) {
      manual.push({
        projectId: dep.projectId,
        reason: 'no-compatible-version',
        ...(displayName === undefined ? {} : { displayName }),
      })
      continue
    }
    const file = version.files.find((f) => f.primary) ?? version.files[0]
    if (file === undefined) {
      manual.push({
        projectId: dep.projectId,
        reason: 'no-download-file',
        ...(displayName === undefined ? {} : { displayName }),
      })
      continue
    }
    installs.push({
      projectId: dep.projectId,
      versionId: version.versionId,
      displayName: version.name,
      fileName: file.filename,
      url: file.url,
      size: file.size,
      hashes: file.hashes,
      requiredBy: dep.requiredBy,
      confidence,
    })
  }

  return { installs, manual }
}
