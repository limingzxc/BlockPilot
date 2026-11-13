import { join } from 'node:path'
import { diagHint, preflightHint, setupHint } from '../../core/hints.js'
import { createLaunchPlan } from '../../core/launch/index.js'
import { createLauncher } from '../../core/launch/run.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume, consumeValue } from '../consume/index.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { assetsIncompleteHint } from '../render/assets.js'
import { renderAuthFailure, renderAuthNotice, renderOfflineNameWarning } from '../render/auth.js'
import { renderJavaFailure } from '../render/java.js'
import { parseMemoryArg, parseStopArg, positional } from '../shared/args.js'
import { resolveAuth } from '../use-cases/auth.js'
import { instanceConfig } from '../use-cases/instance.js'
import { pickJava } from '../use-cases/java.js'

export const cmdRun = defineCommand({
  name: 'run',
  positional: '<version>',
  summary: '真的启动游戏，转发日志并落盘到 <实例>/logs/',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--quiet': '只显示 ERROR 级日志',
    '--stop': { takesValue: true, value: '<秒>', help: '到时自动结束（测试用）' },
    '--java': { takesValue: true, value: '<path>', help: '用哪个 java；缺省自动挑' },
    '--memory': { takesValue: true, value: '<MB>', help: '最大堆内存（MB），512–65536' },
    '--user': { takesValue: true, value: '<name>', help: '离线用户名，缺省 Player' },
    '--account': {
      takesValue: true,
      value: '<name>',
      help: '用指定账号（在线）；缺省用上次登录的',
    },
    '--offline': '强制离线模式，不读账号存档',
    '--china': CHINA,
  },
  run: runGame,
})

export async function runGame(ctx: CommandContext): Promise<number> {
  const versionId = positional(ctx)
  if (versionId === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const root = layout.root
  const quiet = ctx.has('--quiet')
  const autoStopSeconds = parseStopArg(ctx.value('--stop'))
  const config = instanceConfig(ctx)

  // 参数校验放在所有 I/O 之前：--memory 写错时不该先去探测 Java、解析版本，
  // 让用户等几秒才看到「其实是你参数写错了」
  const maxMemoryMiB = parseMemoryArg(ctx.value('--memory')) ?? config.memoryMiB

  const java = await pickJava(versionId, layout, ctx.signal, ctx.value('--java') ?? config.javaPath)
  if (!java.ok) {
    renderJavaFailure(java)
    return 1
  }
  const javaPath = java.path

  const auth = await resolveAuth(ctx)
  if (!auth.ok) {
    renderAuthFailure(auth)
    return 1
  }
  if (auth.notice !== undefined) renderAuthNotice(auth.notice)

  const offlineUsername = ctx.value('--user') ?? 'Player'
  // 有正版账号时名字来自账号，--user 不生效，别误报
  if (auth.account === undefined) renderOfflineNameWarning(offlineUsername)
  const planOp = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: offlineUsername,
    ...(auth.account === undefined ? {} : { account: auth.account }),
    ...(maxMemoryMiB === undefined ? {} : { maxMemoryMiB }),
    ...(config.jvmArgs === undefined ? {} : { extraJvmArgs: config.jvmArgs }),
    mirror: ctx.china,
  })

  // 真正启动是下一个 Operation；exit 留给它
  const { code: planCode, value: plan } = await consumeValue(
    planOp,
    { progress: () => {}, log: () => {}, exitEvent: false },
    ctx.signal,
  )
  if (planCode !== 0 || plan === undefined) return 1

  if (plan.missing.length > 0) {
    process.stderr.write(
      `\n${C.red}文件不齐${C.reset}：缺 ${plan.missing.length} 个\n` +
        `  ${C.dim}先跑：${setupHint(versionId, root)}${C.reset}\n\n`,
    )
    return 1
  }

  // 文件齐了，但资源可能没装：不说的话用户会在标题画面崩一次才知道
  const missingAssets = assetsIncompleteHint(plan.assets, versionId)
  if (missingAssets !== undefined) {
    process.stderr.write(`\n${C.yellow}!${C.reset} ${missingAssets}\n`)
  }

  say('\n')
  say(`  ${C.green}启动${C.reset} ${plan.versionId} · 实例 ${layout.instanceId}\n`)
  say(`  ${C.dim}${plan.java}${C.reset}\n`)
  say(`  ${C.dim}日志实时输出，Ctrl+C 结束${C.reset}\n\n`)

  const op = createLauncher({
    plan,
    logsDir: join(layout.gameDir, 'logs'),
    ...(autoStopSeconds === undefined ? {} : { autoStopSeconds }),
  })

  return consume(
    op,
    {
      progress: () => {},
      log: (ev) => {
        if (ev.code === 'game.output') {
          if (quiet && ev.level !== 'error') return
          process.stderr.write(
            ev.level === 'error'
              ? `${C.red}${ev.data.line}${C.reset}\n`
              : `${C.dim}${ev.data.line}${C.reset}\n`,
          )
        } else if (ev.code === 'launch.spawn_failed') {
          process.stderr.write(`${C.red}启动失败${C.reset}: ${ev.data.message}\n`)
        } else if (ev.code === 'launch.autostop') {
          process.stderr.write(`\n${C.yellow}到达 --stop 时限，正在结束游戏${C.reset}\n`)
        }
      },
      exitCode: (result) => (result.crashed ? 2 : 0),
      result: (result) => {
        const secs = (result.durationMs / 1000).toFixed(1)
        say('\n')
        if (result.stopped) {
          say(
            `  ${C.green}${result.aborted ? '已中断' : '已到时限结束'}${C.reset}  ${secs}s · ${result.lineCount} 行日志\n`,
          )
          if (result.logPath !== undefined) {
            say(`  ${C.dim}日志${C.reset}  ${result.logPath}\n`)
          }
          say('\n')
          return
        }
        if (result.crashed) {
          say(
            `  ${C.red}异常退出${C.reset}  code=${result.exitCode ?? '-'} signal=${result.signal ?? '-'} · ${secs}s · ${result.lineCount} 行日志\n`,
          )
          if (result.diedBeforeStop) {
            say(
              `  ${C.yellow}游戏在中途就停了${C.reset}${C.dim}（进程一直没退，--stop 到点才被结束）${C.reset}\n`,
            )
          }
          if (result.logPath !== undefined) {
            say(`  ${C.dim}完整日志${C.reset}  ${result.logPath}\n`)
          }
          say('\n')
          say(`  ${C.bold}下一步${C.reset}\n`)
          say(`    ${diagHint(root, layout.instanceId)}      ${C.dim}# 分析这份日志${C.reset}\n`)
          say(`    ${preflightHint(layout.gameDir)}   ${C.dim}# 扫描实例里的 mods${C.reset}\n\n`)
          return
        }

        say(`  ${C.green}正常退出${C.reset}  ${secs}s · ${result.lineCount} 行日志\n`)
        if (result.logPath !== undefined) {
          say(`  ${C.dim}日志${C.reset}  ${result.logPath}\n`)
        }
        say('\n')
      },
    },
    ctx.signal,
  )
}
