import type { InstanceConfig } from '../../core/instance/config.js'
import { configPath, readConfig, writeConfig } from '../../core/instance/config.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { INSTANCE, ROOT } from '../common-flags.js'
import { parseMemoryArg, UsageError } from '../shared.js'
import { C, say } from '../ui.js'

export const cmdConfig = defineCommand({
  name: 'config',
  summary: '查看或修改实例配置（默认内存 / Java / JVM 参数）',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--memory': { takesValue: true, value: '<MB>', help: '实例默认堆内存（512–65536）' },
    '--java': { takesValue: true, value: '<path>', help: '实例默认 java 路径' },
    '--jvm-args': {
      takesValue: true,
      value: '<args>',
      help: '追加的 JVM 参数，空格分隔（如 "-XX:+UseG1GC -XX:+AlwaysPreTouch"）',
    },
    '--unset': {
      takesValue: true,
      value: '<keys>',
      help: '删除配置项，逗号分隔：memory,java,jvmArgs',
    },
    '--json': '输出 JSON',
  },
  notes: ['命令行参数优先于实例配置；配置文件在 <实例>/.blockpilot/config.json'],
  run: runConfig,
})

export function renderConfig(c: InstanceConfig, gameDir: string): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}实例配置${C.reset}  ${C.dim}${configPath(gameDir)}${C.reset}`)
  lines.push('')
  lines.push(
    `  memory   ${c.memoryMiB === undefined ? `${C.dim}未设置（启动时按默认值）${C.reset}` : `${c.memoryMiB} MB`}`,
  )
  lines.push(`  java     ${c.javaPath ?? `${C.dim}未设置（自动挑）${C.reset}`}`)
  lines.push(
    `  jvmArgs  ${c.jvmArgs === undefined || c.jvmArgs.length === 0 ? `${C.dim}无${C.reset}` : c.jvmArgs.join(' ')}`,
  )
  lines.push('')
  return lines.join('\n')
}

export async function runConfig(ctx: CommandContext): Promise<number> {
  const layout = ctx.layout
  const asJson = ctx.has('--json')
  const config = readConfig(layout.gameDir)

  const memoryArg = ctx.value('--memory')
  const javaArg = ctx.value('--java')
  const jvmArgsArg = ctx.value('--jvm-args')
  const unset = (ctx.value('--unset') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const changed =
    memoryArg !== undefined || javaArg !== undefined || jvmArgsArg !== undefined || unset.length > 0

  if (!changed) {
    if (asJson) say(`${JSON.stringify({ path: configPath(layout.gameDir), config }, null, 2)}\n`)
    else say(renderConfig(config, layout.gameDir))
    return 0
  }

  const next: {
    version: 1
    memoryMiB?: number
    javaPath?: string
    jvmArgs?: readonly string[]
  } = { ...config }

  if (memoryArg !== undefined) {
    const m = parseMemoryArg(memoryArg)
    if (m !== undefined) next.memoryMiB = m
  }
  if (javaArg !== undefined) next.javaPath = javaArg
  if (jvmArgsArg !== undefined) {
    next.jvmArgs = jvmArgsArg.split(/\s+/).filter((a) => a !== '')
  }
  for (const key of unset) {
    switch (key) {
      case 'memory':
      case 'memoryMiB':
        delete next.memoryMiB
        break
      case 'java':
      case 'javaPath':
        delete next.javaPath
        break
      case 'jvmArgs':
      case 'jvm-args':
        delete next.jvmArgs
        break
      default:
        throw new UsageError(
          'BAD_CONFIG_KEY',
          `--unset 不认识 ${key}`,
          '可选：memory, java, jvmArgs',
        )
    }
  }

  const path = writeConfig(layout.gameDir, next)
  if (asJson) {
    say(`${JSON.stringify({ path, config: next }, null, 2)}\n`)
  } else {
    say(`${C.green}已写入${C.reset} ${path}\n`)
    say(renderConfig(next, layout.gameDir))
  }
  return 0
}
