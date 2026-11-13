import { totalmem } from 'node:os'
import { join } from 'node:path'

import type { HostProfile } from '../instance.js'
import { detectJava } from '../java/detect.js'
import type { JavaInstall } from '../java/types.js'
import { defaultRoot } from '../layout.js'

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
 *
 * `root` 与 CLI 的 `--root` 同义：`java install` 把 JRE 装在 `<root>/java`，
 * 不把托管目录交给扫描器的话，装完的 Java 在 preflight / deploy 眼里不存在。
 * 没给 root 时退回默认数据根，这样 MCP 这类没有 `--root` 的消费者也能看见。
 */
export async function detectHost(
  opts: {
    readonly java?: readonly JavaInstall[]
    readonly managedJavaDir?: string
    readonly root?: string
    /** 测试注入：观察真正传给扫描器的托管目录 */
    readonly detect?: typeof detectJava
  } = {},
): Promise<HostProfile> {
  const managedJavaDir = opts.managedJavaDir ?? join(opts.root ?? defaultRoot(), 'java')
  const installs: readonly JavaInstall[] =
    opts.java ?? (await (opts.detect ?? detectJava)({ managedDir: managedJavaDir })).installs

  return {
    os: mapOs(process.platform),
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    javaMajors: [...new Set(installs.map((j) => j.major))].sort((a, b) => a - b),
  }
}
