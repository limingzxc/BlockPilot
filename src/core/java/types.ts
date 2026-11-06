/** 本机的一个 Java 运行时。 */
export interface JavaInstall {
  /** java 可执行文件的绝对路径 */
  readonly path: string
  /** 完整版本号，如 17.0.9 / 1.8.0_392 */
  readonly version: string
  /** 大版本，如 8 / 17 / 21 */
  readonly major: number
  readonly vendor?: string
  readonly arch?: string
  /** 从哪找到的。managed 指启动器自己装的 */
  readonly source: JavaSource
}

export type JavaSource = 'java_home' | 'path' | 'scan' | 'managed'

export interface JavaScanResult {
  readonly installs: readonly JavaInstall[]
  /** 扫到但探测失败的路径（文件不存在、不是 JVM、超时） */
  readonly rejected: readonly { readonly path: string; readonly reason: string }[]
}

/**
 * MC 版本 → 需要的 Java 大版本。唯一的一份，preflight 也从这里读。
 *
 * 权威来源是版本 JSON 的 `javaVersion.majorVersion`（Mojang 自己写的）。这张表
 * 只用于拿不到 JSON 的场景，所以它是**下限**：不确定时给更高的，宁可多装不可少装。
 *
 * 两代版本号体系都要覆盖：
 * - `1.x`：1.16.5 → 8，1.17–1.20.4 → 17，1.20.5+ → 21
 * - 日历版：26.1–26.3 的版本 JSON 全部写 `majorVersion: 25`（java-runtime-epsilon）。
 *   以前这里一律返回 21，比真实需求低，等于告诉用户「Java 21 够用」——
 *   有 Java 21 的机器会检查通过，然后游戏以 UnsupportedClassVersionError 启动失败。
 */
export function requiredJavaMajor(gameVersion: string): number {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(gameVersion)
  if (!m) return 21
  const major = Number(m[1])
  const minor = m[2] === undefined ? 0 : Number(m[2])
  const patch = m[3] === undefined ? 0 : Number(m[3])
  // 日历版：26.x 起要求 Java 25。27.x 若再抬高，这里要跟着改——
  // 但返回 25 至少不会给出「21 够用」这种会导致启动失败的错误结论。
  if (major !== 1) return major >= 26 ? 25 : 21
  if (minor <= 16) return 8
  if (minor < 20) return 17
  if (minor === 20 && patch < 5) return 17
  return 21
}

/**
 * 挑一个满足要求大版本的 Java。
 *
 * 优先级：精确匹配里优先我们自己装的（managed），其次系统里的；都没有就取最小的更高版本。
 *
 * 为什么优先 managed：用户用 `java install` 装的东西是他明确选择的结果，
 * 而系统里那个 Java 可能是别的软件带来的，不该默认盖过它。
 */
export function pickJava(installs: readonly JavaInstall[], needMajor: number): JavaInstall | null {
  const exact = installs.filter((j) => j.major === needMajor)
  if (exact.length > 0) {
    return exact.find((j) => j.source === 'managed') ?? exact[0] ?? null
  }
  const newer = installs.filter((j) => j.major > needMajor).sort((a, b) => a.major - b.major)
  return newer[0] ?? null
}
