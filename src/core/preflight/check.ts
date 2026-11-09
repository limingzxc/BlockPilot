import { javaInstallHint } from '../hints.js'
import type { HostProfile, Instance, LoaderKind } from '../instance.js'
import { requiredJavaMajor } from '../java/types.js'
import { compareVersions, satisfiesRange } from '../semver.js'
import type { VersionInfo } from '../sources.js'
import type { Finding } from './types.js'

export interface CheckInput {
  readonly instance: Instance
  readonly versions: ReadonlyMap<string, VersionInfo>
}

/** Modrinth 的 version.loaders 取值与我们的 LoaderKind 同名，vanilla 除外。 */
function loaderToken(kind: LoaderKind): string | null {
  return kind === 'vanilla' ? null : kind
}

/**
 * 目标游戏版本与模组声明版本的关系。
 *
 * 不是「在不在列表里」这么简单：Modrinth 的 `game_versions` 是作者发版时
 * **手动勾选**的清单，和 jar 内 `depends.minecraft` 是两份独立数据。作者升了兼容性
 * 却没回去补勾，是生态里极常见的情况——ADR-0026 的口径：
 *
 * - `below`：目标版本低于模组声明过的最低版本。模组用到的 API 那个版本里可能
 *   根本不存在，**必崩**，维持 blocker。
 * - `above`：目标版本高于最高版本。可能真没适配，也可能只是没勾，降为 warning。
 * - `declared`：正常命中。
 * - `gap`：落在声明区间中间但没勾（如声明 1.20.1 与 1.21.1，目标是 1.20.4）。
 *   方向不明，保守起见仍按 blocker 处理。
 */
type VersionFit =
  | { readonly fit: 'declared' }
  | { readonly fit: 'below' | 'above'; readonly bound: string }
  | { readonly fit: 'gap' }

function judgeGameVersion(target: string, declared: readonly string[]): VersionFit {
  if (declared.includes(target)) return { fit: 'declared' }

  let min: string | undefined
  let max: string | undefined
  for (const candidate of declared) {
    if (min === undefined || max === undefined) {
      min = candidate
      max = candidate
      continue
    }
    const lo = compareVersions(candidate, min)
    const hi = compareVersions(candidate, max)
    // 看不懂的写法（预发布、加料版本号）不参与定界，否则会把边界算歪
    if (lo === null || hi === null) continue
    if (lo < 0) min = candidate
    if (hi > 0) max = candidate
  }
  if (min === undefined || max === undefined) return { fit: 'gap' }

  const belowMin = compareVersions(target, min)
  const aboveMax = compareVersions(target, max)
  if (belowMin === null || aboveMax === null) return { fit: 'gap' }
  if (belowMin < 0) return { fit: 'below', bound: min }
  if (aboveMax > 0) return { fit: 'above', bound: max }
  return { fit: 'gap' }
}

/**
 * 模组自己声明的 Java 范围（`fabric.mod.json` 的 `depends.java`）。
 *
 * 这张表比「MC 版本 → Java」的兜底表可靠：BTWCE 在 MC 1.6.4 上要求 `>=17 <=21`，
 * 兜底表只会看到 1.6.4 → 8，于是建议用户装 Java 8——照做这个包就废了（issue #11）。
 */
export interface JavaRequirement {
  readonly modId: string
  readonly range: string
}

/** 从范围里挑一个「该装的大版本」：满足条件的最小整数。 */
function suggestMajorFor(range: string): number | undefined {
  for (let major = 8; major <= 30; major += 1) {
    if (satisfiesRange(String(major), range) === 'satisfied') return major
  }
  return undefined
}

/**
 * Java 可用性检查。独立于在线/离线模式——两种链路都要跑。
 *
 * 判定分三档：
 * - 有精确版本：通过（更高版本只记一条 info）
 * - 没有精确版本但有更高版本：warning。Java 向后兼容，多数情况能跑，
 *   但老 Forge 常常栽在 Java 版本差异上，所以不判 blocker
 * - 一个都够不上：blocker
 *
 * `requirements` 非空时**不再用兜底表下结论**：模组说了算。
 */
export function checkJava(
  instance: Instance,
  host: HostProfile,
  requirements: readonly JavaRequirement[] = [],
  /** 版本 JSON 的 `javaVersion.majorVersion`。给了就以它为准，表只是兜底 */
  opts: { readonly javaMajor?: number } = {},
): readonly Finding[] {
  const findings: Finding[] = []

  if (requirements.length > 0) {
    const hostText = host.javaMajors.join(', ') || '无'
    for (const req of requirements) {
      const ok = host.javaMajors.some((j) => satisfiesRange(String(j), req.range) !== 'violated')
      if (ok) continue
      const suggest = suggestMajorFor(req.range)
      findings.push({
        severity: 'blocker',
        code: 'JAVA_INCOMPATIBLE_WITH_MOD',
        message: `${req.modId} 要求 Java ${req.range}，本机检测到 ${hostText}`,
        hint:
          suggest === undefined
            ? '这个范围里没有可安装的大版本，核对 mod 说明；也可能是它自己写错了'
            : `装 Java ${suggest}：${javaInstallHint(suggest)}`,
      })
    }
    // 有模组明确声明时，不再叠加「1.12 只能用 Java 8」这类推断——
    // 两张表冲突时模组自己说的算，否则用户会收到互相矛盾的两条建议
    return findings
  }

  const need = opts.javaMajor ?? requiredJavaMajor(instance.gameVersion)
  const exact = host.javaMajors.includes(need)
  const newer = host.javaMajors.filter((j) => j > need)
  const older = host.javaMajors.filter((j) => j < need)

  if (!exact && newer.length === 0) {
    findings.push({
      severity: 'blocker',
      code: 'JAVA_MISSING',
      message: `Minecraft ${instance.gameVersion} 需要 Java ${need}，本机未检测到`,
      // 「已检测到：无」是个死胡同。保留现场，同时给一条能直接敲的命令
      hint: `已检测到：${host.javaMajors.join(', ') || '无'} · 装一个再重试：${javaInstallHint(need)}`,
    })
  } else if (!exact) {
    if (need === 8) {
      // 「更高的 Java 多数能跑」是 1.17+ 的经验。1.12 及更早的版本不行：
      // 老 Forge 的类转换器与 MC 自己都依赖 Java 8 的类加载行为，Java 9+ 会在
      // 启动阶段就死（UnsupportedClassVersionError / mixin 初始化失败）。
      // 给 warning 等于告诉用户「可以试」，实际是白跑一次再回来。
      findings.push({
        severity: 'blocker',
        code: 'JAVA_TOO_NEW',
        message: `Minecraft ${instance.gameVersion} 只能用 Java 8，本机只有 Java ${newer.join(', ')}`,
        hint: `1.12 及更早的版本在 Java 9+ 上起不来；装一个 Java 8：${javaInstallHint(8)}`,
      })
    } else {
      findings.push({
        severity: 'warning',
        code: 'JAVA_NEWER_ONLY',
        message: `没有 Java ${need}，但检测到更高的 Java ${newer.join(', ')}`,
        hint: `多数情况下能启动；若加载器报版本错误，装一个 Java ${need}`,
      })
    }
  } else if (older.length > 0) {
    findings.push({
      severity: 'info',
      code: 'JAVA_OLDER_PRESENT',
      message: `本机同时存在更低版本的 Java（${older.join(', ')}），启动时必须显式指定路径`,
    })
  }

  return findings
}

/**
 * 物理内存与模组规模的粗判。
 *
 * `HostProfile.totalMemoryMiB` 一直在采集，但从来没用过——于是 3 GB 内存的机器
 * 装 300 个模组，预检会给一个干净的 OK，然后在启动时 OOM。
 *
 * 这里只报**有证据**的两件事：物理内存多少、模组多少个。堆大小给一个按
 * 「1 GB 起步 + 每个模组 6 MB」估算的推荐值，不声称是精确解。
 */
export function checkMemory(instance: Instance, host: HostProfile): readonly Finding[] {
  const total = host.totalMemoryMiB
  if (!Number.isFinite(total) || total <= 0) return []
  const mods = instance.mods.length
  const recommended = Math.min(8192, Math.max(2048, Math.round((1024 + mods * 6) / 512) * 512))

  if (total < 4096) {
    return [
      {
        severity: 'warning',
        code: 'LOW_MEMORY',
        message: `本机物理内存 ${total} MB，实例有 ${mods} 个模组`,
        data: { totalMemoryMiB: total, mods, recommendedHeapMiB: recommended },
        hint:
          `1.19+ 在 4 GB 以下很容易 OOM。建议 -Xmx${recommended}M，并关掉其他占内存的程序；` +
          '内存不足时游戏表现为启动卡死或 Java heap space 崩溃',
      },
    ]
  }
  if (mods >= 250 && total <= 8192) {
    return [
      {
        severity: 'warning',
        code: 'LOW_MEMORY',
        message: `${mods} 个模组的实例，本机只有 ${total} MB 物理内存`,
        hint: `建议 -Xmx${recommended}M；大型整合包通常需要 6–8 GB 堆`,
      },
    ]
  }
  return []
}

/**
 * 确定性检查。同一输入永远得到同一输出，不依赖网络与时间。
 * 例外：`generatedAt` 在调用方生成，不进入本函数。
 *
 * 只管模组层面的事。Java 与内存由 checkJava 负责，因为离线模式也要跑。
 */
export function checkInstance(input: CheckInput): readonly Finding[] {
  const { instance, versions } = input
  const findings: Finding[] = []

  const known: VersionInfo[] = []
  for (const mod of instance.mods) {
    const info = mod.versionId === undefined ? undefined : versions.get(mod.versionId)
    if (info === undefined) {
      findings.push({
        severity: 'info',
        code: 'UNRESOLVED_MOD',
        message: `无法获取 ${mod.fileName} 的元数据，该模组未参与检查`,
        subject: mod.fileName,
        hint:
          mod.source === 'local'
            ? '本地文件无法自动校验，需人工确认'
            : '内容源未返回该版本，可能已下架',
      })
      continue
    }
    known.push(info)

    /**
     * 来源没给版本清单时不要判版本。
     *
     * 空数组会被 judgeGameVersion 读成「声明里没有一个版本」，直接产出 blocker。
     * CurseForge 上确实有作者没填 gameVersions 的文件，那种包不该被判成「不支持 1.12.2」。
     */
    const fit =
      info.gameVersions.length === 0
        ? ({ fit: 'declared' } as VersionFit)
        : judgeGameVersion(instance.gameVersion, info.gameVersions)
    if (fit.fit === 'below') {
      findings.push({
        severity: 'blocker',
        code: 'VERSION_MISMATCH',
        message: `${info.name} 最低要求 Minecraft ${fit.bound}，不会在 ${instance.gameVersion} 上工作`,
        subject: info.projectId,
        data: {
          projectId: info.projectId,
          target: instance.gameVersion,
          declared: info.gameVersions,
        },
        hint: `该模组支持的版本：${info.gameVersions.slice(0, 5).join(', ') || '未知'}`,
      })
    } else if (fit.fit === 'above') {
      // 作者标注的清单里没有这个版本。可能真没适配，也可能只是没回去补勾——
      // 判 blocker 会让官方整合包因为一个调试模组整体「装不上」，见 ADR-0026
      findings.push({
        severity: 'warning',
        code: 'VERSION_UNVERIFIED',
        message: `${info.name} 作者标注的版本里没有 Minecraft ${instance.gameVersion}（最高到 ${fit.bound}）`,
        subject: info.projectId,
        hint: '可能还没适配，也可能只是发版时没勾；装完跑一次 preflight <实例目录>，那时读的是真 jar',
      })
    } else if (fit.fit === 'gap') {
      findings.push({
        severity: 'blocker',
        code: 'VERSION_MISMATCH',
        message: `${info.name} 不支持 Minecraft ${instance.gameVersion}`,
        subject: info.projectId,
        data: {
          projectId: info.projectId,
          target: instance.gameVersion,
          declared: info.gameVersions,
        },
        hint: `该模组支持的版本：${info.gameVersions.slice(0, 5).join(', ') || '未知'}`,
      })
    }

    // 同理：加载器清单为空 = 来源没提供，不等于「不支持这个加载器」
    const token = loaderToken(instance.loader.kind)
    if (token !== null && info.loaders.length > 0 && !info.loaders.includes(token)) {
      findings.push({
        severity: 'blocker',
        code: 'LOADER_MISMATCH',
        message: `${info.name} 不支持 ${instance.loader.kind} 加载器`,
        subject: info.projectId,
        hint: `该模组支持的加载器：${info.loaders.join(', ') || '未知'}`,
      })
    }
  }

  const present = new Set(known.map((v) => v.projectId))

  // 注意：required 依赖不在这里查。单层判断会漏掉「依赖的依赖」，
  // 它由 deps/closure.ts 的递归闭包负责。这里只处理不需要递归的声明式冲突。
  for (const info of known) {
    for (const dep of info.dependencies) {
      if (dep.kind === 'incompatible' && dep.projectId !== null && present.has(dep.projectId)) {
        findings.push({
          severity: 'blocker',
          code: 'DECLARED_INCOMPATIBLE',
          message: `${info.name} 声明与 ${dep.projectId} 不兼容，但两者都在实例中`,
          subject: info.projectId,
          hint: '移除其中一个',
        })
      }
    }
  }

  for (const info of known) {
    const mod = instance.mods.find((m) => m.projectId === info.projectId)
    if (mod?.client === 'unsupported') {
      findings.push({
        severity: 'warning',
        code: 'SERVER_ONLY_MOD',
        message: `${info.name} 声明为仅服务端可用，装在客户端通常无意义`,
        subject: info.projectId,
        hint: '确认是否误装；留着一般不会崩溃，但会白占内存',
      })
    }
  }

  return findings
}
