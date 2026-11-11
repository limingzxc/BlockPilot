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
import type { ScannedMod, ScanResult } from '../instance/scan.js'
import type { HostProfile, Instance } from '../instance.js'
import { depKey } from '../modmeta/types.js'
import type { VersionInfo } from '../sources.js'
import { checkAssets } from './assets.js'
import type { JavaRequirement } from './check.js'
import { checkInstance, checkJava, checkMemory } from './check.js'
import { checkLocalInstance } from './local.js'
import type { Finding, PreflightReport } from './types.js'
import { verdictOf } from './types.js'

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
  /** 注入时钟：装配函数保持纯的，测试与快照不用跟真实时间赛跑 */
  readonly now?: () => Date
}

/**
 * findings + stats → 报告。
 *
 * `unknown` 那条规则住在这里：有东西没校验过时，"ok" 是不可信的结论。
 * 规则只在这一个地方：deploy 自己再算一遍就会漏（ADR-0037）。
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
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
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

/** 目录式证据：有它才查本地依赖与 assets。 */
export interface DirEvidence {
  /** 实例目录本身。assets 的缺省发现要用它（见 findAssetsDir） */
  readonly path: string
  readonly scan: ScanResult
  /** assets 目录。缺省按 path 往上找；deploy 传 layout.assets 就是这条 */
  readonly assetsDir?: string
  /** 版本 JSON 里的 `assetIndex.id`。缺省按实例附近的版本 JSON 或同名 index 猜 */
  readonly assetIndexId?: string
}

/**
 * 一次预检的全部证据。
 *
 * 三个来源（目录 / 在线 / CurseForge）只是「证据怎么来」不同；**查哪些 checker
 * 只由这里决定**。此前 `createPreflight` 的包分支与 `preflightDir` 各挑一遍，
 * 结果包预检从来不做内存检查——同一个 host，`preflight <包>` 与 `preflight <目录>`
 * 给出不同结论。
 */
export interface PreflightEvidence {
  readonly instance: Instance
  readonly host?: HostProfile
  /** 版本 JSON 的 `javaVersion.majorVersion`；缺省按 gameVersion 查表 */
  readonly javaMajor?: number
  /** 目录式证据 */
  readonly dir?: DirEvidence
  /** 在线 / CurseForge 已解析到的版本元数据：有它就做模组级检查 */
  readonly versions?: ReadonlyMap<string, VersionInfo>
  /** 来源特有的 findings（PACK_BUILTIN_MODS、CF_NO_MOD_CHECK、依赖闭包……） */
  readonly extraFindings?: readonly Finding[]
  readonly plan?: RepairPlan
  /** 注入时钟，见 AssembleInput.now */
  readonly now?: () => Date
}

/**
 * 证据 → 报告。checker 集合、stats 算法、verdict 规则都只在这条路径上。
 *
 * 目录预检、整合包预检、deploy 的部署后自检都从这里出结论。
 */
export function preflightFrom(input: PreflightEvidence): PreflightReport {
  const { instance, dir } = input
  const findings: Finding[] = []

  if (input.host !== undefined) {
    findings.push(
      // Java 与在线/离线无关。模组自己声明的范围比「MC 版本 → Java」的兜底表准（issue #11）
      ...checkJava(
        instance,
        input.host,
        dir === undefined ? [] : javaRequirements(dir.scan.mods),
        input.javaMajor === undefined ? {} : { javaMajor: input.javaMajor },
      ),
      ...checkMemory(instance, input.host),
    )
  }

  if (dir !== undefined) {
    findings.push(
      ...checkLocalInstance(dir.scan, {
        gameVersion: instance.gameVersion,
        loaderVersion: instance.loader.version,
      }),
      // 资源包不在 mods 里，但缺了同样起不来——单独查一层（issue #2）
      ...checkAssets(dir.path, instance.gameVersion, dir.assetsDir, dir.assetIndexId),
    )
  }

  if (input.versions !== undefined) {
    findings.push(...checkInstance({ instance, versions: input.versions }))
  }
  findings.push(...(input.extraFindings ?? []))

  return assembleReport({
    findings,
    stats:
      dir === undefined
        ? statsForVersions(instance, input.versions?.size ?? 0)
        : statsForScan(dir.scan),
    target: { gameVersion: instance.gameVersion, loader: instance.loader },
    plan: input.plan ?? EMPTY_PLAN,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

/** skipped 是「没参与检查」：数字上要和 resolved 分开，否则 verdict 会给出假通过。 */
function statsForScan(scan: ScanResult): ReportStats {
  return {
    mods: scan.mods.length + scan.skipped.length,
    resolved: scan.mods.length,
    unresolved: scan.skipped.length,
  }
}

function statsForVersions(instance: Instance, resolved: number): ReportStats {
  return {
    mods: instance.mods.length,
    resolved,
    unresolved: instance.mods.length - resolved,
  }
}

export interface DirReportInput {
  /** 实例目录本身。assets 的缺省发现要用它（见 findAssetsDir） */
  readonly dir: string
  readonly scan: ScanResult
  readonly host?: HostProfile
  /** assets 目录。缺省按 `dir` 往上找；deploy 传 layout.assets 就是这条 */
  readonly assetsDir?: string
  /** 注入时钟，见 AssembleInput.now */
  readonly now?: () => Date
  /** 版本 JSON 里的 Java 需求。缺省按 gameVersion 查表 */
  readonly javaMajor?: number
  /** 版本 JSON 里的 `assetIndex.id`。缺省按实例附近的版本 JSON 或同名 index 猜 */
  readonly assetIndexId?: string
}

/**
 * 一个磁盘上的 Instance 的完整预检：Java + 内存 + 本地依赖 + assets，然后装配。
 *
 * `scan` 由调用方扫好传进来：目录扫描还被 deploy 与诊断复用，
 * 在这里再扫一遍只是多读一次磁盘。
 */
export function preflightDir(input: DirReportInput): PreflightReport {
  return preflightFrom({
    instance: input.scan.instance,
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(input.javaMajor === undefined ? {} : { javaMajor: input.javaMajor }),
    dir: {
      path: input.dir,
      scan: input.scan,
      ...(input.assetsDir === undefined ? {} : { assetsDir: input.assetsDir }),
      ...(input.assetIndexId === undefined ? {} : { assetIndexId: input.assetIndexId }),
    },
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}
