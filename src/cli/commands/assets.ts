import { createAssetsSetup } from '../../core/setup/assets.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA, ROOT } from '../common-flags.js'
import { parseConcurrencyArg, positional } from '../shared.js'
import { C, consume, humanBytes, say } from '../ui.js'

export const cmdAssets = defineCommand({
  name: 'assets',
  positional: '<version>',
  summary: '下载 assets 对象（音效/语言/字体，约 600 MB、3000+ 文件）',
  flags: {
    '--root': ROOT,
    '--dry-run': '只算要下载什么，不下载',
    '--china': CHINA,
    '--concurrency': { takesValue: true, value: '<n>', help: '并发数，缺省 8' },
  },
  notes: ['1.19+ 必装：原版资源就在 assets 里，缺了会崩在标题画面'],
  run: runAssets,
})

export async function runAssets(ctx: CommandContext): Promise<number> {
  const versionId = positional(ctx)
  if (versionId === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const dryRun = ctx.has('--dry-run')
  const concurrency = parseConcurrencyArg(ctx.value('--concurrency'))

  say('\n')
  say(`  ${C.dim}root${C.reset}  ${layout.root}\n\n`)

  const op = createAssetsSetup({
    layout,
    versionId,
    dryRun,
    sources: ctx.sources,
    mirror: ctx.china,
    ...(concurrency === undefined ? {} : { concurrency }),
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}${C.reset}                    `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        if (ev.code === 'assets.tasks') {
          process.stderr.write(
            `${C.dim}· index 里 ${ev.data.keys} 个 key，去重后 ${ev.data.unique} 个对象 · ${humanBytes(ev.data.totalBytes)}${C.reset}\n`,
          )
        } else if (ev.code === 'assets.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${ev.data.file}  ${ev.data.error}\n`)
        }
      },
      exitCode: (r) => (r.failed.length > 0 ? 2 : 0),
      result: (r) => {
        say('\n')
        if (dryRun) {
          say(`  ${C.yellow}--dry-run${C.reset}：${r.unique} 个对象需要下载\n\n`)
          return
        }
        say(
          `  ${C.green}完成${C.reset} 下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length} · ${humanBytes(r.totalBytes)}\n\n`,
        )
      },
    },
    ctx.signal,
  )
}
