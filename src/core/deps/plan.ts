import type { ClosureResult } from './closure.js'

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
}

export type ManualReason = 'no-compatible-version' | 'no-download-file'

/** 查得到问题、但没法自动修的那部分。 */
export interface ManualFix {
  readonly projectId: string
  readonly reason: ManualReason
}

export interface RepairPlan {
  readonly installs: readonly PlannedInstall[]
  readonly manual: readonly ManualFix[]
}

/**
 * 把依赖闭包翻译成可执行的安装计划。
 *
 * 只处理「缺依赖」这一类问题——版本不匹配、声明不兼容都不是装一个东西能解决的，
 * 硬塞进 plan 只会让消费者误以为能一键修复。
 */
export function buildRepairPlan(closure: ClosureResult): RepairPlan {
  const installs: PlannedInstall[] = []
  const manual: ManualFix[] = []

  for (const dep of closure.missing) {
    const version = dep.resolved
    if (version === null) {
      manual.push({ projectId: dep.projectId, reason: 'no-compatible-version' })
      continue
    }
    const file = version.files.find((f) => f.primary) ?? version.files[0]
    if (file === undefined) {
      manual.push({ projectId: dep.projectId, reason: 'no-download-file' })
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
    })
  }

  return { installs, manual }
}
