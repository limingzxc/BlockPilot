import type { ClosureResult } from './closure.js'
import type {
  InstallConfidence,
  ManualFix,
  PlannedInstall,
  PlanOptions,
  RepairPlan,
} from './types.js'

/** 没有可自动补装的东西。报告里用它，避免每个装配点各写一遍 `installs: []`。 */
export const EMPTY_PLAN: RepairPlan = { installs: [], manual: [] }

/**
 * 把依赖闭包翻译成可执行的安装计划。
 *
 * 只处理「缺依赖」这一类问题——版本不匹配、声明不兼容都不是装一个东西能解决的，
 * 硬塞进 plan 只会让消费者误以为能一键修复。
 */
export function buildRepairPlan(closure: ClosureResult, opts: PlanOptions = {}): RepairPlan {
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
