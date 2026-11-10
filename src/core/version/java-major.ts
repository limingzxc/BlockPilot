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

/**
 * 从版本 JSON 读 `assetIndex.id`。
 *
 * 现代版本的 index id 是 `5` / `17` / `32` 这类数字，和 MC 版本号没有关系。
 * 抽查 assets 时必须用这个值，不能按目录里的文件名猜（见 preflight/assets.ts）。
 */
export function readAssetIndexId(versionJsonPath: string): string | undefined {
  if (!existsSync(versionJsonPath)) return undefined
  try {
    const raw = JSON.parse(readFileSync(versionJsonPath, 'utf8')) as {
      assetIndex?: { id?: unknown }
    }
    const id = raw.assetIndex?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  } catch {
    return undefined
  }
}
