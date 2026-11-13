/**
 * 用法文本：从命令声明派生，不再维护第二份名单。
 *
 * 结构：用法 → 通用 flag → 共享概念（`<target>`）→ 每条命令的说明与自己的 flag。
 * 通用 flag 只解释一次：`--root` 出现在十条命令里，逐个重复只会把帮助撑长。
 */

import type { Command } from './define.js'
import type { FlagSpec } from './flags.js'

function label(flag: string, f: FlagSpec): string {
  const text = f.takesValue ? `${flag} ${f.value ?? ''}` : flag
  return f.required === true ? text : `[${text}]`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** 用法总览里的一行。 */
export function synopsis(c: Command): string {
  const parts = [`blockpilot ${c.name}`]
  if (c.positional !== undefined) parts.push(c.positional)
  for (const [flag, f] of Object.entries(c.flags)) parts.push(label(flag, f))
  return parts.join(' ')
}

/** `--help` 的全文。 */
export function usageText(commands: readonly Command[]): string {
  const lines: string[] = []
  lines.push('BlockPilot — AI-drivable launcher core')
  lines.push('')
  lines.push('  用法：blockpilot <命令> [位置参数] [flag]')
  lines.push('')

  // 通用 flag：按第一次出现的顺序去重
  const common = new Map<string, FlagSpec>()
  for (const c of commands) {
    for (const [flag, f] of Object.entries(c.flags)) {
      if (f.common === true && !common.has(flag)) common.set(flag, f)
    }
  }
  const commonRows = [...common.entries()].map(([flag, f]) => ({
    label: f.takesValue ? `${flag} ${f.value ?? ''}` : flag,
    help: f.help ?? '',
  }))
  commonRows.push({
    label: '--proxy <url>',
    help: '走 HTTP 代理（也读 HTTPS_PROXY 环境变量），影响元数据、下载与 installer',
  })
  commonRows.push({
    label: '--events',
    help: '输出 ndjson 事件流（每行一个事件，最后一行是 exit code），不混入人类文本',
  })

  lines.push('  通用：')
  for (const row of commonRows) {
    const width = Math.max(...commonRows.map((r) => r.label.length))
    lines.push(`    ${pad(row.label, width)}  ${row.help}`)
  }
  lines.push('')
  lines.push('  <target>  .mrpack / CurseForge 的 zip（带 manifest.json），或实例目录')
  lines.push('            （MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录）')
  lines.push('')

  for (const c of commands) {
    lines.push(`  ${synopsis(c)}`)
    lines.push(`      ${c.summary}`)

    const rows = Object.entries(c.flags)
      .filter(([, f]) => f.common !== true)
      .map(([flag, f]) => ({
        label: f.takesValue ? `${flag} ${f.value ?? ''}` : flag,
        help: f.help ?? '',
      }))
    if (rows.length > 0) {
      const width = Math.max(...rows.map((r) => r.label.length))
      for (const row of rows) lines.push(`      ${pad(row.label, width)}  ${row.help}`)
    }
    for (const note of c.notes ?? []) lines.push(`      ${note}`)
    lines.push('')
  }

  return lines.join('\n')
}
