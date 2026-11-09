import { checkLocalDeps } from '../deps/localDeps.js'
import type { ScanResult } from '../instance/scan.js'
import { depKey } from '../modmeta/types.js'
import { satisfiesRange } from '../semver.js'
import type { Finding } from './types.js'

/**
 * 离线检查一个实例目录。
 *
 * 与在线预检的区别：没有 projectId，给不出下载地址，但能做版本比对——
 * `minecraft` / `fabricloader` 的约束是靠实例的版本信息（而不是 mod 元数据）判定的。
 *
 * 逻辑抽在这里而不是内联在 preflight 里，是因为 `deploy` 装完也要跑同一套检查。
 */
export function checkLocalInstance(
  scan: ScanResult,
  ctx: { readonly gameVersion: string; readonly loaderVersion: string },
): readonly Finding[] {
  const findings: Finding[] = []

  const issues = checkLocalDeps(
    scan.mods.map((m) => ({
      modId: m.meta.modId,
      version: m.meta.version,
      dependencies: m.meta.dependencies,
      provides: m.meta.provides,
      nested: m.meta.nested,
      loader: m.meta.loader,
    })),
    { gameVersion: ctx.gameVersion, loaderVersion: ctx.loaderVersion },
  )

  for (const issue of issues) {
    if (issue.kind === 'version') {
      findings.push({
        severity: 'blocker',
        code: 'DEPENDENCY_VERSION_MISMATCH',
        message:
          `${issue.requiredBy.join('、')} 要求 ${issue.modId} ${issue.requiredRange ?? ''}，` +
          `实际是 ${issue.actualVersion ?? '未知'}`,
        subject: issue.modId,
        hint:
          issue.modId === 'fabricloader'
            ? '加载器版本太低，换更高的 loader 版本重装'
            : issue.modId === 'minecraft'
              ? '模组不支持当前 MC 版本'
              : '换一个满足版本要求的模组',
      })
      continue
    }
    findings.push({
      severity: 'blocker',
      code: 'MISSING_DEPENDENCY',
      message: `${issue.requiredBy.join('、')} 需要前置模组 ${issue.modId}，本地目录里没有`,
      subject: issue.modId,
      data: { modId: issue.modId, requiredBy: issue.requiredBy },
      hint: '本地元数据只提供 modId，没有下载地址；需要联网反查才能给出可安装版本',
    })
  }

  // 同一 modId 多份 jar：Fabric/Forge 都会在启动时拒绝，属于确定性失败
  const byId = new Map<string, string[]>()
  for (const m of scan.mods) {
    const key = depKey(m.meta.modId)
    const list = byId.get(key) ?? []
    list.push(m.fileName)
    byId.set(key, list)
  }
  for (const [modId, files] of byId) {
    if (files.length <= 1) continue
    findings.push({
      severity: 'blocker',
      code: 'DUPLICATE_MOD',
      message: `同一个模组有 ${files.length} 份 jar：${modId}`,
      subject: modId,
      data: { modId, files },
      hint: `删掉多余的：${files.join('、')}。加载器遇到重复 modId 会直接拒绝启动`,
    })
  }

  // 加载器装错：Fabric 模组放进 Forge 实例不会「部分工作」，而是加载阶段就失败
  const instanceLoader = scan.instance.loader.kind
  if (instanceLoader !== 'vanilla') {
    for (const m of scan.mods) {
      const declared = m.meta.loader
      if (declared === 'unknown') continue
      // Quilt 兼容 Fabric 模组；其余只认同名加载器
      const compatible =
        declared === instanceLoader || (instanceLoader === 'quilt' && declared === 'fabric')
      if (compatible) continue
      findings.push({
        severity: 'warning',
        code: 'LOADER_MISMATCH',
        message: `${m.meta.modId} 是 ${declared} 模组，当前实例是 ${instanceLoader}`,
        subject: m.meta.modId,
        data: { modId: m.meta.modId, declared, instance: instanceLoader },
        hint:
          instanceLoader === 'quilt'
            ? 'Quilt 只能直接加载 Fabric / Quilt 模组；Forge 模组需要 Sinytra Connector 之类的兼容层'
            : `这个模组不会在 ${instanceLoader} 上加载；换对应加载器的版本，或换实例`,
      })
    }
  }

  // breaks / incompatible：双方都在实例里就是确定性冲突
  const present = new Map<string, string | undefined>()
  for (const m of scan.mods) {
    present.set(depKey(m.meta.modId), m.meta.version)
    for (const p of m.meta.provides) present.set(depKey(p), undefined)
    for (const n of m.meta.nested) present.set(depKey(n.modId), n.version)
  }
  for (const m of scan.mods) {
    for (const dep of m.meta.dependencies) {
      if (dep.kind !== 'breaks') continue
      if (!present.has(depKey(dep.modId))) continue
      // 带范围时只在「确实落在范围内」才报；范围看不懂或版本缺失时宁可不报
      if (dep.versionRange !== undefined) {
        const actual = present.get(depKey(dep.modId))
        if (actual === undefined) continue
        if (satisfiesRange(actual, dep.versionRange) !== 'satisfied') continue
      }
      findings.push({
        severity: 'blocker',
        code: 'DECLARED_INCOMPATIBLE',
        message: `${m.meta.modId} 声明与 ${dep.modId} 不兼容，两者都在实例里`,
        subject: m.meta.modId,
        data: { modId: m.meta.modId, incompatibleWith: dep.modId },
        hint: '移除其中一个；如果确实需要共存，确认作者是否提供了兼容版本',
      })
    }
  }

  if (scan.corrupt.length > 0) {
    findings.push({
      severity: 'warning',
      code: 'CORRUPT_JAR',
      message: `${scan.corrupt.length} 个 jar 已损坏（不是完整的压缩包），游戏会因此启动失败`,
      ...(scan.corrupt[0] === undefined ? {} : { subject: scan.corrupt[0] }),
      hint: `删掉重下：${scan.corrupt.slice(0, 5).join('、')}${
        scan.corrupt.length > 5 ? ' 等' : ''
      }。用 blockpilot install 装的文件会校验 sha1，一般不会出现这种情况`,
    })
  }

  // 范围是 skipped 里「没坏、只是没有可识别元数据」的那部分。
  // 这类文件是正常的（资源包、把老库改名成 .jar），报 warning 只会制造噪音。
  const noMeta = scan.skipped.filter((f) => !scan.corrupt.includes(f))
  if (noMeta.length > 0) {
    findings.push({
      severity: 'info',
      code: 'UNREADABLE_JAR',
      message: `${noMeta.length} 个 jar 里没有可识别的模组元数据，未参与检查`,
      hint: `${noMeta.slice(0, 5).join('、')}${noMeta.length > 5 ? ' 等' : ''}。资源包/非模组 jar 属于正常情况`,
    })
  }

  if (ctx.gameVersion === 'unknown') {
    findings.push({
      severity: 'warning',
      code: 'UNKNOWN_GAME_VERSION',
      message: '目录里没有版本信息，无法校验 MC 版本与 Java',
      hint: 'Prism/MultiMC 实例的 mmc-pack.json 可提供；否则需要显式指定',
    })
  }

  return findings
}
