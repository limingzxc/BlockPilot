import { USER_AGENT } from '../user-agent.js'

const ADOPTIUM_API = 'https://api.adoptium.net/v3/assets/latest'
const TIMEOUT_MS = 25_000

export type JavaOs = 'windows' | 'linux' | 'mac'

export interface JavaBinary {
  readonly release: string
  readonly url: string
  readonly fileName: string
  readonly size: number
  /** sha256 十六进制 */
  readonly checksum: string
  /** zip 还是 tar.gz —— 决定用什么解压 */
  readonly archive: 'zip' | 'tar.gz'
}

/** Adoptium 的 os 命名：mac 是 `mac`，不是 `osx` */
function adoptiumOs(os: JavaOs): string {
  return os === 'mac' ? 'mac' : os
}

function archOf(): 'x64' | 'aarch64' {
  return process.arch === 'arm64' ? 'aarch64' : 'x64'
}

interface AdoptiumAsset {
  readonly release_name?: string
  readonly binary?: {
    readonly package?: {
      readonly link?: string
      readonly name?: string
      readonly size?: number
      readonly checksum?: string
    }
  }
}

/**
 * 查 Adoptium（Eclipse Temurin）的最新 JRE。
 *
 * 用 `assets/latest` 而不是 `binary/latest`：后者是 302 直接跳二进制，
 * 拿不到 checksum。按 ADR-0005，没有哈希的文件不下载。
 */
export async function fetchJavaBinary(
  major: number,
  os: JavaOs,
  signal?: AbortSignal,
): Promise<JavaBinary | null> {
  const params = new URLSearchParams({
    architecture: archOf(),
    image_type: 'jre',
    os: adoptiumOs(os),
    vendor: 'eclipse',
  })
  const url = `${ADOPTIUM_API}/${major}/hotspot?${params.toString()}`

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.any([
        ...(signal === undefined ? [] : [signal]),
        AbortSignal.timeout(TIMEOUT_MS),
      ]),
    })
    if (!res.ok) return null
    const list = (await res.json()) as AdoptiumAsset[]
    const first = list[0]
    const pkg = first?.binary?.package
    if (pkg?.link === undefined || pkg.name === undefined || pkg.checksum === undefined) {
      return null
    }
    return {
      release: first?.release_name ?? `${major}`,
      url: pkg.link,
      fileName: pkg.name,
      size: pkg.size ?? 0,
      checksum: pkg.checksum,
      // Windows 给 zip，Linux/macOS 给 tar.gz
      archive: pkg.name.endsWith('.zip') ? 'zip' : 'tar.gz',
    }
  } catch {
    return null
  }
}
