import type { HostProfile, Instance, LoaderKind } from '../instance.js'
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
 * 从 MC 版本号推断所需 Java 大版本。
 *
 * 覆盖两代版本号体系：`1.x` 与日历版（如 `26.3`）。
 * 后者一律按 21 处理——不确定时给更高版本，宁可多装不可少装。
 */
export function requiredJavaMajor(gameVersion: string): number {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(gameVersion)
  if (!m) return 21
  const major = Number(m[1])
  const minor = m[2] === undefined ? 0 : Number(m[2])
  const patch = m[3] === undefined ? 0 : Number(m[3])
  if (major !== 1) return 21
  if (minor <= 16) return 8
  if (minor < 20) return 17
  if (minor === 20 && patch < 5) return 17
  return 21
}

/**
 * Java 可用性检查。独立于在线/离线模式——两种链路都要跑。
 *
 * 判定分三档：
 * - 有精确版本：通过（更高版本只记一条 info）
 * - 没有精确版本但有更高版本：warning。Java 向后兼容，多数情况能跑，
 *   但老 Forge 常常栽在 Java 版本差异上，所以不判 blocker
 * - 一个都够不上：blocker
 */
export function checkJava(instance: Instance, host: HostProfile): readonly Finding[] {
  const findings: Finding[] = []
  const need = requiredJavaMajor(instance.gameVersion)
  const exact = host.javaMajors.includes(need)
  const newer = host.javaMajors.filter((j) => j > need)
  const older = host.javaMajors.filter((j) => j < need)

  if (!exact && newer.length === 0) {
    findings.push({
      severity: 'blocker',
      code: 'JAVA_MISSING',
      message: `Minecraft ${instance.gameVersion} 需要 Java ${need}，本机未检测到`,
      hint: `已检测到：${host.javaMajors.join(', ') || '无'}`,
    })
  } else if (!exact) {
    findings.push({
      severity: 'warning',
      code: 'JAVA_NEWER_ONLY',
      message: `没有 Java ${need}，但检测到更高的 Java ${newer.join(', ')}`,
      hint: `多数情况下能启动；若加载器报版本错误，装一个 Java ${need}`,
    })
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
        hint: mod.source === 'local' ? '本地文件无法自动校验，需人工确认' : '内容源未返回该版本，可能已下架',
      })
      continue
    }
    known.push(info)

    if (!info.gameVersions.includes(instance.gameVersion)) {
      findings.push({
        severity: 'blocker',
        code: 'VERSION_MISMATCH',
        message: `${info.name} 不支持 Minecraft ${instance.gameVersion}`,
        subject: info.projectId,
        hint: `该模组支持的版本：${info.gameVersions.slice(0, 5).join(', ') || '未知'}`,
      })
    }

    const token = loaderToken(instance.loader.kind)
    if (token !== null && !info.loaders.includes(token)) {
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
          hint: '移除其中一个'
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
