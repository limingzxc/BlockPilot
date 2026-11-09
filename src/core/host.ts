import { totalmem } from 'node:os'

import type { HostProfile } from './instance.js'
import { detectJava } from './java/detect.js'
import type { JavaInstall } from './java/types.js'

function mapOs(platform: NodeJS.Platform): HostProfile['os'] {
  switch (platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

/**
 * 采集本机环境。预检靠它判断 Java 是否够用、内存是否可能不够。
 *
 * Java 检测要起若干次 JVM 进程，通常 1–3 秒。调用方如果不需要，
 * 直接构造 HostProfile 传进来即可，不必走这里。
 */
export async function detectHost(
  opts: { readonly java?: readonly JavaInstall[]; readonly managedJavaDir?: string } = {},
): Promise<HostProfile> {
  const installs =
    opts.java ??
    (
      await detectJava({
        ...(opts.managedJavaDir === undefined ? {} : { managedDir: opts.managedJavaDir }),
      })
    ).installs

  return {
    os: mapOs(process.platform),
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    javaMajors: [...new Set(installs.map((j) => j.major))].sort((a, b) => a - b),
  }
}
