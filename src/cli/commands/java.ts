import { join } from 'node:path'
import { createJavaScan } from '../../core/java/index.js'
import { createJavaInstall } from '../../core/java/install.js'
import type { JavaScanResult } from '../../core/java/types.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA, ROOT } from '../common-flags.js'
import { positional } from '../shared.js'
import { C, consume, humanBytes, say } from '../ui.js'

export const cmdJava = defineCommand({
  name: 'java',
  positional: '[install] [major]',
  summary: '列出本机可用的 Java；`java install <major>` 从 Adoptium 下载 JRE',
  flags: { '--root': ROOT, '--china': CHINA },
  notes: ['安装目标：<root>/java。国内 --china 走清华 TUNA，内容仍按 Adoptium 的 sha256 校验'],
  run: runJava,
})

export async function runJava(ctx: CommandContext): Promise<number> {
  if (positional(ctx) === 'install') return runJavaInstall(ctx)

  return consume(
    createJavaScan({ root: ctx.root }),
    {
      log: () => {},
      exitCode: () => 0,
      result: (r) => {
        say(renderJava(r))
      },
    },
    ctx.signal,
  )
}

export async function runJavaInstall(ctx: CommandContext): Promise<number> {
  // 第一个位置参数是 `install`，大版本在它后面
  const majorArg = ctx.argv[1]
  if (majorArg === undefined || majorArg.startsWith('--')) {
    ctx.usage()
    return 1
  }
  const major = Number(majorArg)
  if (!Number.isFinite(major) || major < 8) {
    process.stderr.write(`${C.red}无效的 Java 大版本：${majorArg}${C.reset}\n`)
    return 1
  }

  const layout = ctx.layout

  say('\n')
  say(`  ${C.dim}安装 Java${C.reset} ${major} → ${join(layout.root, 'java')}\n\n`)

  const op = createJavaInstall({
    layout,
    major,
    sources: ctx.sources,
  })

  return consume(
    op,
    {
      log: (ev) => {
        if (ev.code === 'java.download') {
          process.stderr.write(
            `${C.dim}· ${ev.data.release} · ${humanBytes(ev.data.size)}${C.reset}\n`,
          )
        } else if (ev.code === 'java.extract') {
          // 命中本地缓存时一个字节都没下，别说成「下载完成」
          const how = ev.data.cached ? '使用已下载的包' : '下载完成'
          const from = ev.data.credit === undefined ? '' : ` · ${ev.data.credit}`
          process.stderr.write(
            `${C.dim}· ${how} ${humanBytes(ev.data.bytes)}${from}，解压中…${C.reset}\n`,
          )
        }
      },
      exitCode: () => 0,
      result: (r) => {
        say(
          `  ${C.green}${r.skipped ? '已存在' : '装好了'}${C.reset}  Java ${r.java.major} · ${r.java.version}\n`,
        )
        say(`  ${C.dim}${r.java.path}${C.reset}\n\n`)
      },
    },
    ctx.signal,
  )
}

export function renderJava(r: JavaScanResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot java${C.reset}`)
  lines.push('')

  if (r.installs.length === 0) {
    lines.push(`  ${C.red}没有找到可用的 Java${C.reset}`)
    lines.push(
      `  ${C.dim}MC 1.16.5 及以下要 Java 8，1.17–1.20.4 要 Java 17，1.20.5+ 要 Java 21${C.reset}`,
    )
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`  找到 ${r.installs.length} 个`)
  lines.push('')
  for (const j of r.installs) {
    const vendor = j.vendor ?? '未知厂商'
    lines.push(
      `  ${C.green}Java ${j.major}${C.reset}  ${C.dim}${j.version.padEnd(14)}${vendor.padEnd(24)}${j.path}${C.reset}`,
    )
  }
  lines.push('')

  if (r.rejected.length > 0) {
    lines.push(`  ${C.dim}${r.rejected.length} 个候选路径探测失败（不是 JVM 或不可执行）${C.reset}`)
    lines.push('')
  }
  return lines.join('\n')
}
