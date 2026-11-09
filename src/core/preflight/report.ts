/**
 * 预检报告的装配。
 *
 * 三个 checker（Java / 本地依赖 / assets）各自回答一个问题；「把它们的产出折成
 * 一个 verdict」是另一件事，只该有一份实现。折法写两份的代价已经出现过：
 * `deploy` 的部署后自检手抄了 `checkLocalInstance` + `checkAssets`，漏了 `checkJava`，
 * 也没有 unknown 规则——于是装完打「部署后检查 通过」，紧接着 run 因为 Java 版本死掉，
 * 同一个实例、同一分钟。
 *
 * 这里放两件事：
 * - `assembleReport`：findings + stats → PreflightReport。verdict 与 stats 的规则只在这。
 * - `preflightDir`：一个磁盘上的 Instance → 完整报告。preflight 与 deploy 自检共用。
 */

import type { RepairPlan } from '../deps/plan.js'
import { EMPTY_PLAN } from '../deps/plan.js'
import type { HostProfile } from '../instance.js'
import type { ScanResult, ScannedMod } from '../instance/scan.js'
import { depKey } from '../modmeta/types.js'
import { checkAssets } from './assets.js'
import { checkJava } from './check.js'
import type { JavaRequirement } from './check.js'
import { checkLocalInstance } from './local.js'
import { verdictOf } from './types.js'
import type { Finding, PreflightReport } from './types.js'

/**
 * 报告里的计数。
 *
 * 三条链路（目录 / CurseForge / 在线）算法不同，但折成报告的接口相同：
 * `resolved` 是真正校验过的，`unresolved` 是「没校验到」——不是「有问题」。
 */
export interface ReportStats {
  readonly mods: number
  readonly resolved: number
  readonly unresolved: number
}

export interface AssembleInput {
  readonly findings: readonly Finding[]
  readonly stats: ReportStats
  readonly target?: PreflightReport['target']
  readonly plan?: RepairPlan
}

/**
 * findings + stats → 报告。
 *
 * `unknown` 那条规则住在这里：有东西没校验过时，"ok" 是不可信的结论。
 * 它以前只写在 preflight 里，deploy 自己算 verdict 就漏了。
 */
export function assembleReport(input: AssembleInput): PreflightReport {
  const base = verdictOf(input.findings)
  const verdict = base === 'ok' && input.stats.unresolved > 0 ? 'unknown' : base

  return {
    verdict,
    findings: input.findings,
    stats: input.stats,
    ...(input.target === undefined ? {} : { target: input.target }),
    plan: input.plan ?? EMPTY_PLAN,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * 从 jar 元数据里收集模组自己声明的 Java 范围。
 *
 * 只认 Fabric/Quilt 的 `depends.java`（Forge 的 mods.toml 没有这个字段，
 * 它用 javafml + loaderVersion 表达类似约束）。没写范围的不算。
 */
export function javaRequirements(mods: readonly ScannedMod[]): JavaRequirement[] {
  const out: JavaRequirement[] = []
  for (const m of mods) {
    for (const dep of m.meta.dependencies) {
      if (depKey(dep.modId) !== 'java' || dep.versionRange === undefined) continue
      out.push({ modId: m.meta.modId, range: dep.versionRange })
    }
  }
  return out
}

export interface DirReportInput {
  /** 实例目录本身。assets 的缺省发现要用它（见 findAssetsDir） */
  readonly dir: string
  readonly scan: ScanResult
  readonly host?: HostProfile
  /** assets 目录。缺省按 `dir` 往上找；deploy 传 layout.assets 就是这条 */
  readonly assetsDir?: string
}

/**
 * 一个磁盘上的 Instance 的完整预检：Java + 本地依赖 + assets，然后装配。
 *
 * `scan` 由调用方扫好传进来：目录扫描还被 deploy 与诊断复用，
 * 在这里再扫一遍只是多读一次磁盘。
 */
export function preflightDir(input: DirReportInput): PreflightReport {
  const { scan } = input
  const { instance } = scan

  const findings: Finding[] = [
    // Java 与在线/离线无关。模组自己声明的范围比「MC 版本 → Java」的兜底表准（issue #11）
    ...(input.host === undefined ? [] : checkJava(instance, input.host, javaRequirements(scan.mods))),
    ...checkLocalInstance(scan, {
      gameVersion: instance.gameVersion,
      loaderVersion: instance.loader.version,
    }),
    // 资源包不在 mods 里，但缺了同样起不来——单独查一层（issue #2）
    ...checkAssets(input.dir, instance.gameVersion, input.assetsDir),
  ]

  return assembleReport({
    findings,
    // skipped 是「没参与检查」：数字上要和 resolved 分开，否则 verdict 会给出假通过
    stats: {
      mods: scan.mods.length + scan.skipped.length,
      resolved: scan.mods.length,
      unresolved: scan.skipped.length,
    },
    target: { gameVersion: instance.gameVersion, loader: instance.loader },
  })
}
