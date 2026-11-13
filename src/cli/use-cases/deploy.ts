/**
 * `deploy` 的装配用例：把 CLI 的输入与 core 的实现拼成一个 Operation。
 *
 * 命令文件只保留声明与渲染；host 检测、包读取、Java 选择、sources 注入都在这里。
 * 这一层不写 stdout/stderr（Java 缺失的提示由 use-cases/java 负责），
 * 装配失败直接抛给命令层渲染。
 *
 * 如果 MCP 以后也要 deploy，这一段应搬到 `core/deploy/assemble.ts`，
 * 由两个 consumer 各自注入 sources 与 java。
 */

import { createContentSources } from '../../assembly.js'
import type { DeployResult } from '../../core/deploy/index.js'
import { createDeploy } from '../../core/deploy/index.js'
import type { PackTarget } from '../../core/deploy/pack-source.js'
import { resolvePackTarget } from '../../core/deploy/pack-source.js'
import type { Operation } from '../../core/events/operation.js'
import { detectHost } from '../../core/host/index.js'
import { readConfig } from '../../core/instance/config.js'
import type { LoaderKind } from '../../core/instance.js'
import type { Layout } from '../../core/layout.js'
import type { PackFileRead } from '../../core/pack/index.js'
import { readPackFile } from '../../core/pack/index.js'
import { loaderNeedsJava } from '../../core/setup/loader.js'
import type { CommandContext } from '../command/context.js'
import { pickJava } from './java.js'

export interface DeployAssembly {
  readonly op: Operation<DeployResult>
  readonly layout: Layout
  readonly instance: string
  readonly packPath: string
  readonly remote?: NonNullable<PackTarget['remote']>
  /** Java 选择失败时的提示；op 仍会按原行为报 NEED_JAVA */
  readonly javaWarning?: { readonly message: string; readonly needMajor?: number }
}

export async function assembleDeploy(ctx: CommandContext, target: string): Promise<DeployAssembly> {
  const layout = ctx.layout
  const content = createContentSources({
    china: ctx.china,
    allowCfMirror: !ctx.has('--no-cf-mirror'),
  })

  const resolved = await resolvePackTarget({
    target,
    layout,
    source: content.modrinth,
    mirrors: ctx.sources,
    signal: ctx.signal,
  })
  const packPath = resolved.path

  // 部署后自检要判 Java。检测会起若干次 JVM 进程（1–3 秒），相比后面几分钟的
  // 下载可以忽略；省掉它的代价是自检看不见 Java 不对，装完打「通过」再崩
  const host = await detectHost({ root: layout.root })

  // Forge 要跑 installer，得有 java。Fabric 用不到，但先检测一次省得后续分支判断。
  // 必须把包里的游戏版本传进去：26.2 要 Java 25，不知道版本就只能「捡最高的那个用」，
  // 机器上只有 Java 8 时也会被当成可用，Forge installer 随后炸得莫名其妙。
  let pack: PackFileRead | undefined
  let packGameVersion: string | undefined
  let packLoaderKind: LoaderKind | undefined
  try {
    pack = readPackFile(packPath)
    packGameVersion = pack.instance.gameVersion
    packLoaderKind = pack.instance.loader.kind
  } catch {
    // 包本身读不出来由 createDeploy 报 BAD_MODPACK，这里不抢它的活
  }
  // 只有 Forge / NeoForge 要 java；对 Quilt 说「没找到可用的 Java」会让人以为装不了
  const needsJava = packLoaderKind !== undefined && loaderNeedsJava(packLoaderKind)
  const config = readConfig(layout.gameDir)
  const java = needsJava
    ? await pickJava(packGameVersion, layout, ctx.signal, ctx.value('--java') ?? config.javaPath)
    : undefined
  const javaPath = java?.ok === true ? java.path : undefined

  const allowHosts = (ctx.value('--allow-host') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '')
  const op = createDeploy({
    packPath,
    ...(pack === undefined ? {} : { pack }),
    layout,
    sources: ctx.sources,
    mirror: ctx.china,
    host,
    ...(allowHosts.length === 0 ? {} : { allowHosts }),
    ...(ctx.has('--overwrite-overrides') ? { overwriteOverrides: true } : {}),
    ...(javaPath === undefined ? {} : { java: javaPath }),
    ...(ctx.proxy === undefined ? {} : { proxy: ctx.proxy }),
    // key 只从环境变量读（ADR-0029）：命令行参数会留在 shell history 里
    curseforge: content.curseforge,
  })

  return {
    op,
    layout,
    instance: layout.instanceId,
    packPath,
    ...(resolved.remote === undefined ? {} : { remote: resolved.remote }),
    ...(java?.ok === false
      ? {
          javaWarning: {
            message: java.message,
            ...(java.needMajor === undefined ? {} : { needMajor: java.needMajor }),
          },
        }
      : {}),
  }
}
