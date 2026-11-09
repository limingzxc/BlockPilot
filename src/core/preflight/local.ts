import { checkLocalDeps } from '../deps/localDeps.js'
import type { ScannedMod, ScanResult } from '../instance/scan.js'
import type { LoaderKind } from '../instance.js'
import type { ModLoaderKind } from '../modmeta/types.js'
import { depKey } from '../modmeta/types.js'
import { satisfiesRange } from '../semver.js'
import type { Finding } from './types.js'

/** 这个模组会不会被实例的加载器真正加载。 */
function loadsOn(declared: ModLoaderKind, instance: LoaderKind): boolean {
  // 读不出加载器的 jar 不能断定它不会被加载，照旧参与检查
  if (declared === 'unknown') return true
  // Quilt 兼容 Fabric 模组；其余只认同名加载器
  return declared === instance || (instance === 'quilt' && declared === 'fabric')
}

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

  const instanceLoader = scan.instance.loader.kind
  /**
   * 加载器不匹配的 jar 单独归类。
   *
   * Forge 遇到没有 `mods.toml` 的 jar 直接忽略，不会崩（304 个 mod 的包实测
   * 跑满 211 秒正常退出）。把这类 jar 声明的依赖算成「缺失」会给出
   * 「satisfying_buttons 需要 fabric-api」这种用户根本无从修的建议（issue #17）。
   */
  const ignored: ScannedMod[] = []
  const active: ScannedMod[] = []
  for (const m of scan.mods) {
    if (instanceLoader !== 'vanilla' && !loadsOn(m.meta.loader, instanceLoader)) ignored.push(m)
    else active.push(m)
  }

  const issues = checkLocalDeps(
    active.map((m) => ({
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
  for (const m of active) {
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

  /**
   * 加载器装错：这类 jar 会被加载器跳过，不会崩。
   *
   * 以前一个 jar 一条 finding、而且在线链路判 blocker，于是「包里有几个装错的 jar」
   * 直接把整个包判死。现在聚合成一条 warning：用户知道有这回事，
   * 也知道它们不影响启动（issue #17）。
   */
  if (ignored.length > 0) {
    const loaders = [...new Set(ignored.map((m) => m.meta.loader))]
    const names = ignored.map((m) => m.meta.modId)
    const files = ignored.map((m) => m.fileName)
    const list = names.slice(0, 5).join('、') + (names.length > 5 ? ' 等' : '')
    findings.push({
      severity: 'warning',
      code: 'LOADER_MISMATCH',
      message: `${loaders.join('/')} 模组在 ${instanceLoader} 实例里不会加载（${names.length} 个）：${list}`,
      ...(names[0] === undefined ? {} : { subject: names[0] }),
      data: { instance: instanceLoader, loaders, mods: names, files },
      hint:
        instanceLoader === 'quilt'
          ? 'Quilt 只能直接加载 Fabric / Quilt 模组；Forge 模组需要 Sinytra Connector 之类的兼容层'
          : `这些 jar 会被 ${instanceLoader} 直接跳过，它们声明的依赖也不参与检查；` +
            `换对应加载器的版本，或换实例`,
    })
  }

  // breaks / incompatible：双方都在实例里就是确定性冲突
  const present = new Map<string, string | undefined>()
  for (const m of active) {
    present.set(depKey(m.meta.modId), m.meta.version)
    for (const p of m.meta.provides) present.set(depKey(p), undefined)
    for (const n of m.meta.nested) present.set(depKey(n.modId), n.version)
  }
  for (const m of active) {
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

  /**
   * 只有 jar-in-jar 子模组的 jar（Forge 的 `-all` 打包）。
   *
   * 这不是问题：顶层没有 mods.toml 是作者的打包方式，子模组已经计入索引。
   * 但不说一句的话，用户会疑惑「这个 jar 是不是没被检查」。
   */
  const nestedOnly = active.filter((m) => m.meta.nestedOnly === true)
  if (nestedOnly.length > 0) {
    const names = nestedOnly.map((m) => m.fileName)
    findings.push({
      severity: 'info',
      code: 'NESTED_ONLY_JAR',
      message: `${nestedOnly.length} 个 jar 没有顶层元数据，按 jar-in-jar 子模组计入索引`,
      ...(nestedOnly[0] === undefined ? {} : { subject: nestedOnly[0].fileName }),
      data: {
        files: names,
        mods: nestedOnly.map((m) => m.meta.modId),
      },
      hint:
        `${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''}。` +
        'Forge 的 -all 打包就是这样：真正的模组在 META-INF/jarjar/ 下，依赖它可以正常解析',
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
