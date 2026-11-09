/**
 * 从版本 JSON 读 `javaVersion.majorVersion`。
 *
 * 这是 Mojang 自己写的权威值；`requiredJavaMajor()` 那张表只是拿不到 JSON 时的
 * 兜底。预检以前一律查表，于是新版本（比如日历版 26.x 要求 25）在表更新前
 * 会给出「Java 21 够用」的错误结论。
 */
import { existsSync, readFileSync } from 'node:fs'

export function readJavaMajor(versionJsonPath: string): number | undefined {
  if (!existsSync(versionJsonPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(versionJsonPath, 'utf8')) as {
      javaVersion?: { majorVersion?: unknown }
    }
    const major = raw.javaVersion?.majorVersion
    return typeof major === 'number' && Number.isFinite(major) ? major : undefined
  } catch {
    return undefined
  }
}
