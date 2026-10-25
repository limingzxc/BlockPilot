import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { JavaInstall, JavaSource } from './types.js'

const execFileAsync = promisify(execFile)

const PROBE_TIMEOUT_MS = 8000

/**
 * 从 `java -XshowSettings:properties -version` 的 stderr 里读出版本。
 *
 * 为什么不用 `java -version`：那行 `openjdk version "17.0.9" 2023-10-17`
 * 格式随厂商变，而 properties 里的 `java.version = 17.0.9` 是稳定的。
 */
export function parseJavaProperties(stderr: string): {
  version: string
  vendor?: string
  arch?: string
} | null {
  const version = /^\s*java\.version\s*=\s*(.+)$/m.exec(stderr)?.[1]?.trim()
  if (version === undefined || version === '') return null
  const vendor = /^\s*java\.vendor\s*=\s*(.+)$/m.exec(stderr)?.[1]?.trim()
  const arch = /^\s*os\.arch\s*=\s*(.+)$/m.exec(stderr)?.[1]?.trim()
  return {
    version,
    ...(vendor === undefined ? {} : { vendor }),
    ...(arch === undefined ? {} : { arch }),
  }
}

/** 1.8.0_392 -> 8；17.0.9 -> 17；21 -> 21 */
export function majorOf(version: string): number {
  const legacy = /^1\.(\d+)/.exec(version)
  if (legacy?.[1] !== undefined) return Number(legacy[1])
  const head = Number(version.split('.')[0])
  return Number.isFinite(head) ? head : 0
}

export async function probeJava(
  path: string,
  source: JavaSource,
): Promise<JavaInstall | null> {
  try {
    const { stderr } = await execFileAsync(path, ['-XshowSettings:properties', '-version'], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    })
    const parsed = parseJavaProperties(stderr)
    if (parsed === null) return null
    const major = majorOf(parsed.version)
    if (major === 0) return null
    return {
      path,
      version: parsed.version,
      major,
      ...(parsed.vendor === undefined ? {} : { vendor: parsed.vendor }),
      ...(parsed.arch === undefined ? {} : { arch: parsed.arch }),
      source,
    }
  } catch (err) {
    // execFile 在退出码非 0 时抛错，但 `java -version` 本来就是走 stderr 正常退出。
    // 真正要区分的是「文件不存在」和「不是 JVM」——两者都当作探测失败。
    const e = err as { stderr?: string }
    if (typeof e.stderr === 'string') {
      const parsed = parseJavaProperties(e.stderr)
      if (parsed !== null) {
        const major = majorOf(parsed.version)
        if (major > 0) {
          return {
            path,
            version: parsed.version,
            major,
            ...(parsed.vendor === undefined ? {} : { vendor: parsed.vendor }),
            ...(parsed.arch === undefined ? {} : { arch: parsed.arch }),
            source,
          }
        }
      }
    }
    return null
  }
}
