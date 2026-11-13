import { join } from 'node:path'
import { listLogs } from '../../core/launch/logfile.js'
import { INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { C, humanBytes } from '../output/ansi.js'
import { say } from '../output/stream.js'

export const cmdLogs = defineCommand({
  name: 'logs',
  summary: '列出会话日志',
  flags: { '--root': ROOT, '--instance': INSTANCE },
  run: runLogs,
})

export async function runLogs(ctx: CommandContext): Promise<number> {
  const layout = ctx.layout
  const logsDir = join(layout.gameDir, 'logs')
  const logs = listLogs(logsDir)

  say('\n')
  say(`  ${C.dim}${logsDir}${C.reset}\n\n`)
  if (logs.length === 0) {
    say(`  ${C.dim}还没有日志。跑一次 run 就会产生。${C.reset}\n\n`)
    return 0
  }
  for (const l of logs) {
    const ago = Math.round((Date.now() - l.mtime) / 60000)
    const when = ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`
    const tag = l.native ? `${C.dim}[游戏原生]${C.reset} ` : ''
    say(`  ${tag}${l.name}  ${C.dim}${humanBytes(l.size)} · ${when}${C.reset}\n`)
  }
  say('\n')
  return 0
}
