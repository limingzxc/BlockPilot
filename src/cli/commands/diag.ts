import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findCrashArtifacts } from '../../core/diagnostics/artifacts.js'
import type { DiagResult } from '../../core/diagnostics/index.js'
import { createDiagnose } from '../../core/diagnostics/index.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { INSTANCE, ROOT } from '../common-flags.js'
import { C, consume, say } from '../ui.js'

export const cmdDiag = defineCommand({
  name: 'diag',
  summary: '分析最近的会话日志，把异常归类成可理解的结论',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--file': { takesValue: true, value: '<path>', help: '指定日志；给定时 --instance 不再生效' },
    '--json': '输出结构化结论（verdict / primary / culprits）',
  },
  run: runDiag,
})

export async function runDiag(ctx: CommandContext): Promise<number> {
  const layout = ctx.layout

  const explicit = ctx.value('--file')
  let logPath = explicit
  if (logPath === undefined) {
    // 证据不只在 logs/：hs_err 在实例根目录，crash-report 在 crash-reports/。
    // 三类按 mtime 排，最新的那份最可能是这次要查的。
    const latest = findCrashArtifacts(layout.gameDir)[0]
    if (latest === undefined) {
      process.stderr.write(
        `${C.red}没有可分析的日志${C.reset}：${layout.gameDir}\n` +
          `${C.dim}先跑一次 blockpilot run；JVM 原生崩溃会留下 hs_err_pid*.log${C.reset}\n`,
      )
      return 1
    }
    logPath = latest.path
    if (latest.kind !== 'log') {
      process.stderr.write(
        `${C.dim}· 使用 ${latest.kind === 'hs-err' ? 'JVM 崩溃报告' : 'Minecraft 崩溃报告'}：${latest.path}${C.reset}\n`,
      )
    }
  }

  // --file 可能指向另一个实例的日志。日志默认在 `<实例>/logs/xxx.log`，
  // 所以优先用日志旁边那个 mods 目录，否则归属会串到当前实例上
  const siblingMods = join(dirname(dirname(logPath)), 'mods')
  const modsDir = existsSync(siblingMods) ? siblingMods : layout.mods

  const op = createDiagnose({ logPath, modsDir })
  const asJson = ctx.has('--json')
  return consume(
    op,
    {
      progress: () => {},
      log: () => {},
      exitCode: (r) => (r.verdict === 'crash' ? 2 : 0),
      result: (r) => {
        // 诊断结论是给机器读的最有价值的一份数据，MCP 那边一直是结构化的，
        // CLI 却只能拿到彩色文本——脚本还得正则解析，没道理
        if (asJson) say(`${JSON.stringify(r, null, 2)}\n`)
        else say(renderDiag(r))
        return r.verdict === 'crash' ? 2 : 0
      },
    },
    ctx.signal,
  )
}

function renderCulprits(r: DiagResult, certain: boolean): string[] {
  const lines: string[] = []
  const top = r.culprits.slice(0, 3)

  if (top.length === 0) {
    if (r.attributionNotes.length > 0) {
      lines.push(`${C.dim}定位不到具体模组${C.reset}`)
      for (const n of r.attributionNotes) lines.push(`  ${C.dim}${n}${C.reset}`)
      lines.push('')
    }
    return lines
  }

  lines.push(
    `${C.bold}${certain ? '指向的模组' : '可能与这些模组有关'}${C.reset}` +
      `${C.dim}（按证据强度排序${certain ? '，越靠前越可能是它' : '，仅供参考'}）${C.reset}`,
  )
  lines.push('')

  for (let i = 0; i < top.length; i += 1) {
    const c = top[i]
    if (c === undefined) continue
    const first = i === 0
    // 没有致命异常时不用红叉：红色在这里会被读成「就是它」
    const mark = first && certain ? `${C.red}✗${C.reset}` : `${C.yellow}?${C.reset}`
    const label = `${c.modId}${c.name === undefined ? '' : ` · ${c.name}`}${
      c.version === undefined ? '' : ` ${c.version}`
    }`

    lines.push(`  ${mark} ${first ? C.bold : ''}${label}${C.reset}`)
    lines.push(`    ${C.dim}${c.fileName} · ${c.frames} 个栈帧${C.reset}`)
    for (const reason of c.reasons.slice(0, 3)) {
      lines.push(`    ${C.dim}· ${reason}${C.reset}`)
    }
    lines.push(`    ${C.dim}${c.sampleFrame.slice(0, 130)}${C.reset}`)
    lines.push('')
  }

  if (top.length > 1) {
    lines.push(
      `  ${C.dim}一个崩溃现场往往牵涉多个模组。先处理第一个，剩下的常常会一起消失。${C.reset}`,
    )
    lines.push('')
  }

  return lines
}

export function renderDiag(r: DiagResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot diag${C.reset}`)
  lines.push('')
  lines.push(`  ${C.dim}${r.logPath}${C.reset}  ${C.dim}${r.lineCount} 行${C.reset}`)
  if (r.crashReport !== undefined) {
    const bits: string[] = []
    if (r.crashReport.description !== undefined) bits.push(r.crashReport.description)
    if (r.crashReport.gameVersion !== undefined) bits.push(`MC ${r.crashReport.gameVersion}`)
    if (r.crashReport.loadedMods > 0) bits.push(`${r.crashReport.loadedMods} 个模组`)
    if (bits.length > 0) lines.push(`  ${C.dim}崩溃报告：${bits.join(' · ')}${C.reset}`)
  }
  lines.push('')

  if (r.verdict === 'clean') {
    lines.push(`  ${C.green}没有在日志里找到异常${C.reset}`)
    lines.push(`  ${C.dim}如果游戏确实崩了，可能日志没写全——看看进程是不是被外部杀掉${C.reset}`)
    lines.push('')
    return lines.join('\n')
  }

  // 有线索但没有致命异常：措辞必须留退路。
  // 这里最容易犯的错是「看起来像崩溃」就写成「崩在谁」，用户照着删错模组。
  if (r.verdict === 'inconclusive') {
    lines.push(`${C.bold}可疑记录${C.reset}${C.dim}（日志里没有致命异常）${C.reset}`)
    lines.push('')
    if (r.primary !== null) {
      lines.push(
        `  ${C.yellow}?${C.reset} ${C.bold}${r.primary.kind}${C.reset}  ${C.dim}第 ${r.primary.line} 行${C.reset}`,
      )
      lines.push(`    ${r.primary.message}`)
      if (r.primary.subject !== undefined) {
        lines.push(`    ${C.dim}文件：${r.primary.subject}${C.reset}`)
      }
      lines.push(`    ${C.cyan}→ ${r.primary.hint}${C.reset}`)
      lines.push('')

      const after = r.lineCount - r.primary.line
      if (after > 0) {
        lines.push(`  ${C.dim}这条之后还有 ${after} 行日志。非致命告警在模组环境里很常见，`)
        lines.push(`  先确认游戏到底有没有崩，再决定要不要动模组。${C.reset}`)
        lines.push('')
      }
    }
    lines.push(...renderCulprits(r, false))

    if (r.primary !== null && r.primary.excerpt.length > 0) {
      lines.push(`  ${C.dim}现场（第 ${r.primary.line} 行附近）${C.reset}`)
      for (const l of r.primary.excerpt.slice(0, 6)) {
        lines.push(`    ${C.dim}${l.slice(0, 140)}${C.reset}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  const others = r.signals.filter((s) => s !== r.primary)

  if (r.primary !== null) {
    lines.push(`${C.bold}最可能的根因${C.reset}`)
    lines.push('')
    lines.push(
      `  ${C.red}✗${C.reset} ${C.bold}${r.primary.kind}${C.reset}  ${C.dim}第 ${r.primary.line} 行${C.reset}`,
    )
    lines.push(`    ${r.primary.message}`)
    if (r.primary.subject !== undefined) {
      lines.push(`    ${C.dim}文件：${r.primary.subject}${C.reset}`)
    }
    lines.push(`    ${C.cyan}→ ${r.primary.hint}${C.reset}`)
    lines.push('')
  }

  if (others.length > 0) {
    lines.push(`${C.dim}其他线索（可能是连锁反应，别急着一个个修）${C.reset}`)
    lines.push('')
    for (const s of others) {
      lines.push(`  ${C.yellow}?${C.reset} ${s.kind}  ${C.dim}第 ${s.line} 行${C.reset}`)
      lines.push(`    ${C.dim}${s.hint}${C.reset}`)
    }
    lines.push('')
  }

  lines.push(...renderCulprits(r, true))

  if (r.primary !== null && r.primary.excerpt.length > 0) {
    lines.push(`  ${C.dim}现场（第 ${r.primary.line} 行附近）${C.reset}`)
    for (const l of r.primary.excerpt.slice(0, 6)) {
      lines.push(`    ${C.dim}${l.slice(0, 140)}${C.reset}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
