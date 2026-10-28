import { existsSync } from 'node:fs'

import type { AuthAccount } from '../auth/types.js'
import type { Layout } from '../layout.js'
import type { VersionJson } from '../version/types.js'
import type { LaunchEnv } from './env.js'
import {
  buildClasspath,
  expandArgs,
  pickLibraries,
  splitLegacyArgs,
  substitute,
  usesOwnClasspath,
} from './command.js'

export interface LaunchPlanOptions {
  /** java 可执行文件 */
  readonly java: string
  readonly layout: Layout
  readonly version: VersionJson
  /** 最底层原版版本 id。加载器版本靠它找 client jar */
  readonly rootVersionId: string
  readonly env: LaunchEnv
  /** 离线模式的玩家名 */
  readonly username: string
  /**
   * 在线账号。给了就走正版登录：真实 uuid / 令牌 / xuid，userType=msa。
   * 不给就是离线模式：全零 uuid、令牌写 '0'、userType=legacy。
   */
  readonly account?: AuthAccount
  /** 最大堆内存，如 2048 */
  readonly maxMemoryMiB?: number
}

export interface LaunchPlan {
  readonly java: string
  readonly mainClass: string
  readonly versionId: string
  /** online 表示带正版令牌启动，offline 表示本地占位身份 */
  readonly mode: 'online' | 'offline'
  /** 进游戏后显示的名字 */
  readonly playerName: string
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
  // natives 是按**原版版本**解压的（setup 时用的是 1.20.1），
  // 加载器版本必须复用同一个目录。用 version.id 会拿到一个空目录，
  // LWJGL 的原生库加载不到，表现为 `NoClassDefFoundError: org/lwjgl/system/MemoryUtil`
  const nativesDir = layout.nativesDir(opts.rootVersionId)
  // 加载器版本没有自己的 jar，用根版本的（Fabric profile 也不给 jar 字段）
  const jarId = version.jar ?? opts.rootVersionId
  const clientJar = layout.clientJar(jarId)
  // Forge 1.17+ 自己管 classpath，塞进原版 jar 会导致模块冲突
  const omitClientJar = usesOwnClasspath(version)

  const { classpath, entries } = buildClasspath(
    version,
    env,
    librariesDir,
    omitClientJar ? null : clientJar,
  )

  const account = opts.account
  const vars: Record<string, string> = {
    auth_player_name: account?.name ?? opts.username,
    version_name: version.id,
    game_directory: gameDir,
    assets_root: assetsDir,
    assets_index_name: version.assetIndex?.id ?? version.assets,
    auth_uuid: account?.uuid ?? '00000000000000000000000000000000',
    auth_access_token: account?.accessToken ?? '0',
    // 1.18+ 的 game args 会引用这两个；离线模式给占位值，
    // 留空会让它们变成两个空参数，游戏解析时容易出错
    clientid: '0',
    auth_xuid: account?.xuid ?? '0',
    // 在线模式必须写 msa。写 legacy 会让游戏按离线身份处理，
    // 令牌被忽略——表现是「登录成功了但进不去服务器」
    user_type: account === undefined ? 'legacy' : 'msa',
    // 部分版本的模板会引用它；不定义会留下未替换的占位符
    user_properties: '{}',
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
  // 用 Set 去重：client jar 也在 entries 里，会重复计一次
  const missing = new Set<string>()
  if (!omitClientJar && !existsSync(clientJar)) missing.add(clientJar)
  for (const entry of entries) {
    if (!existsSync(entry)) missing.add(entry)
  }
  if (version.assetIndex !== undefined) {
    const indexPath = layout.assetIndex(version.assetIndex.id)
    if (!existsSync(indexPath)) missing.add(indexPath)
  }
  const missingList = [...missing]

  const commandLine = [opts.java, ...args.map(quote)].join(' ')

  return {
    java: opts.java,
    mainClass: version.mainClass,
    versionId: version.id,
    mode: account === undefined ? 'offline' : 'online',
    playerName: account?.name ?? opts.username,
    args,
    cwd: gameDir,
    classpath: entries,
    missing: missingList,
    commandLine,
  }
}
