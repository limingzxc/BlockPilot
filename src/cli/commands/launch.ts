import { createLaunchPlan } from '../../core/launch/index.js'
import type { LaunchPlan } from '../../core/launch/plan.js'
import { redactSecrets } from '../../core/redact.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { renderAuthFailure, renderAuthNotice, renderOfflineNameWarning } from '../render/auth.js'
import { renderJavaFailure } from '../render/java.js'
import { parseMemoryArg, positional } from '../shared/args.js'
import { resolveAuth } from '../use-cases/auth.js'
import { instanceConfig } from '../use-cases/instance.js'
import { pickJava } from '../use-cases/java.js'

export const cmdLaunch = defineCommand({
  name: 'launch',
  positional: '<version>',
  summary: '生成启动命令（只打印，不启动）',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--raw': '打印完整命令，不折叠 classpath',
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
  run: runLaunch,
})

export async function runLaunch(ctx: CommandContext): Promise<number> {
  const versionId = positional(ctx)
  if (versionId === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const raw = ctx.has('--raw')
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
  const op = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: offlineUsername,
    ...(auth.account === undefined ? {} : { account: auth.account }),
    ...(maxMemoryMiB === undefined ? {} : { maxMemoryMiB }),
    ...(config.jvmArgs === undefined ? {} : { extraJvmArgs: config.jvmArgs }),
    mirror: ctx.china,
  })

  return consume(
    op,
    {
      exitCode: () => 0,
      result: (plan) => {
        say(renderLaunch(plan, raw))
      },
    },
    ctx.signal,
  )
}

/** 命令可能长达几千字符，classpath 折叠成一个占位符。 */
function compactArgs(plan: LaunchPlan, raw: boolean): string {
  const args = [...plan.args]
  if (raw) return redactSecrets([plan.java, ...args].join(' '))
  const cpIndex = args.indexOf('-cp')
  if (cpIndex !== -1) {
    args[cpIndex + 1] = `<${plan.classpath.length} jars>`
  } else {
    const cpArg = args.findIndex((a) => a.startsWith('-cp') && a.length > 3)
    if (cpArg !== -1) args[cpArg] = `-cp <${plan.classpath.length} jars>`
  }
  // `--raw` 会带出真实的 --accessToken：展示层必须脱敏（ADR-0040）
  return redactSecrets([plan.java, ...args].join(' '))
}

export function renderLaunch(plan: LaunchPlan, raw: boolean): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot launch${C.reset}`)
  lines.push('')
  lines.push(`  版本      ${plan.versionId}`)
  const who = plan.mode === 'online' ? `${plan.playerName}（正版）` : `${plan.playerName}（离线）`
  lines.push(`  身份      ${who}`)
  lines.push(`  Java      ${plan.java}`)
  lines.push(`  主类      ${plan.mainClass}`)
  lines.push(`  类路径    ${plan.classpath.length} 个 jar`)
  lines.push(`  工作目录  ${plan.cwd}`)
  lines.push('')

  lines.push(`${C.bold}命令${C.reset}`)
  lines.push(`  ${C.dim}${compactArgs(plan, raw)}${C.reset}`)
  lines.push('')

  if (plan.missing.length > 0) {
    lines.push(`${C.yellow}文件还没装齐${C.reset}  ${plan.missing.length} 个缺失`)
    lines.push('')
    for (const m of plan.missing.slice(0, 8)) {
      lines.push(`  ${C.dim}${m}${C.reset}`)
    }
    if (plan.missing.length > 8) {
      lines.push(`  ${C.dim}…还有 ${plan.missing.length - 8} 个${C.reset}`)
    }
    lines.push('')
  } else {
    lines.push(`${C.green}所有依赖文件都在位${C.reset}`)
    lines.push('')
  }
  return lines.join('\n')
}
