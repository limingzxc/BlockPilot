import { existsSync } from 'node:fs'

import type { Layout } from '../layout.js'
import type { VersionJson } from '../version/types.js'
import type { LaunchEnv } from './env.js'
import { buildClasspath, expandArgs, pickLibraries, splitLegacyArgs, substitute } from './command.js'

export interface LaunchPlanOptions {
  /** java 可执行文件 */
  readonly java: string
  readonly layout: Layout
  readonly version: VersionJson
  readonly env: LaunchEnv
  /** 离线模式的玩家名 */
  readonly username: string
  /** 最大堆内存，如 2048 */
  readonly maxMemoryMiB?: number
}

export interface LaunchPlan {
  readonly java: string
  readonly mainClass: string
  readonly versionId: string
  /** 传给 java 的完整参数（不含 java 本身） */
  readonly args: readonly string[]
  readonly cwd: string
  readonly classpath: readonly string[]
  /** 命令里引用到、但磁盘上不存在的文件。非空就说明还没装好 */
  readonly missing: readonly string[]
  /** 拼好的完整命令行，仅供展示 */
  readonly commandLine: string
}

function quote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

/**
 * 生成启动命令。纯函数：同样的输入永远得到同样的输出，不读时钟、不发网络。
 *
 * 刻意不在这里启动进程——先让 --dry-run 能看清命令，再谈真的跑。
 * 拼错一个 classpath 分隔符，游戏的报错会指向完全不相干的地方。
 */
export function buildLaunchPlan(opts: LaunchPlanOptions): LaunchPlan {
  const { version, env, layout } = opts
  const gameDir = layout.gameDir
  const librariesDir = layout.libraries
  const assetsDir = layout.assets
  const nativesDir = layout.nativesDir(version.id)
  const clientJar = layout.clientJar(version.id)

  const { classpath, entries } = buildClasspath(version, env, librariesDir, clientJar)

  const vars: Record<string, string> = {
    auth_player_name: opts.username,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: assetsDir,
    assets_index_name: version.assetIndex?.id ?? version.assets,
    auth_uuid: '00000000000000000000000000000000',
    auth_access_token: '0',
    // 1.18+ 的 game args 会引用这两个；离线模式给占位值，
    // 留空会让它们变成两个空参数，游戏解析时容易出错
    clientid: '0',
    auth_xuid: '0',
    user_type: 'legacy',
    version_type: version.type,
    natives_directory: nativesDir,
    launcher_name: 'BlockPilot',
    launcher_version: '0.0.1',
    classpath,
    classpath_separator: env.os === 'windows' ? ';' : ':',
    library_directory: librariesDir,
  }

  const jvm: string[] = []
  if (opts.maxMemoryMiB !== undefined) jvm.push(`-Xmx${opts.maxMemoryMiB}M`)

  if (version.arguments?.jvm !== undefined) {
    jvm.push(...expandArgs(version.arguments.jvm, env).map((a) => substitute(a, vars)))
  } else {
    // 1.12 及更早没有 arguments.jvm，得自己拼
    jvm.push(`-Djava.library.path=${nativesDir}`, '-cp', classpath)
  }

  const rawGame =
    version.arguments?.game !== undefined
      ? expandArgs(version.arguments.game, env)
      : splitLegacyArgs(version.minecraftArguments)
  const game = rawGame.map((a) => substitute(a, vars))

  const args = [...jvm, version.mainClass, ...game]

  // 缺失检查：client jar + 每个 library jar + asset index
  const missing: string[] = []
  if (!existsSync(clientJar)) missing.push(clientJar)
  for (const entry of entries) {
    if (!existsSync(entry)) missing.push(entry)
  }
  if (version.assetIndex !== undefined) {
    const indexPath = layout.assetIndex(version.assetIndex.id)
    if (!existsSync(indexPath)) missing.push(indexPath)
  }

  const commandLine = [opts.java, ...args.map(quote)].join(' ')

  return {
    java: opts.java,
    mainClass: version.mainClass,
    versionId: version.id,
    args,
    cwd: gameDir,
    classpath: entries,
    missing,
    commandLine,
  }
}

/** 供上层预估 natives 解压工作用。 */
export function listNativeLibraries(version: VersionJson, env: LaunchEnv) {
  return pickLibraries(version, env).natives
}
