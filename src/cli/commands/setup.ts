import { gameVersionOf, probeAssets } from '../../core/preflight/assets.js'
import { createVanillaSetup } from '../../core/setup/vanilla.js'
import { readAssetIndexId } from '../../core/version/java-major.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA, INSTANCE, ROOT } from '../common-flags.js'
import { assetsIncompleteHint } from '../render/assets.js'
import { positional } from '../shared.js'
import { C, consume, humanBytes, say } from '../ui.js'

export const cmdSetup = defineCommand({
  name: 'setup',
  positional: '<version>',
  summary: '安装原版：client jar + libraries + assetIndex + 解压 natives',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--dry-run': '只算要下载什么，不下载',
    '--china': CHINA,
  },
  run: runSetup,
})

export async function runSetup(ctx: CommandContext): Promise<number> {
  const versionId = positional(ctx)
  if (versionId === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const dryRun = ctx.has('--dry-run')
  const china = ctx.china

  say('\n')
  say(`  ${C.dim}根目录${C.reset}  ${layout.root}\n`)
  say(`  ${C.dim}实例${C.reset}    ${layout.instanceId} → ${layout.gameDir}\n`)
  say('\n')

  const op = createVanillaSetup({
    layout,
    versionId,
    dryRun,
    sources: ctx.sources,
    mirror: china,
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(
          `\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}          `,
        )
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        if (ev.code === 'setup.ok') {
          process.stderr.write(
            `\r${C.green}↓${C.reset} ${ev.data.file}  ${C.dim}${ev.data.source}${C.reset}\n`,
          )
        } else if (ev.code === 'setup.cached') {
          process.stderr.write(`\r${C.cyan}=${C.reset} ${ev.data.file}\n`)
        } else if (ev.code === 'setup.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${ev.data.file}  ${ev.data.error}\n`)
        } else if (ev.code === 'setup.tasks') {
          process.stderr.write(
            `${C.dim}· ${ev.data.tasks} 个文件 · ${humanBytes(ev.data.totalBytes)}${C.reset}\n`,
          )
        }
      },
      exitCode: (r) => (r.failed.length > 0 ? 2 : 0),
      result: (r) => {
        say('\n')
        if (dryRun) {
          say(`  ${C.yellow}--dry-run${C.reset}：${r.total} 个文件需要下载\n\n`)
          return
        }
        say(
          `  ${C.green}完成${C.reset} 下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length} · ` +
            `解压原生库 ${r.nativesExtracted} 个 · ${humanBytes(r.totalBytes)}\n`,
        )
        for (const f of r.failed.slice(0, 5)) {
          say(`  ${C.red}✗${C.reset} ${f.fileName}  ${C.dim}${f.error}${C.reset}\n`)
        }
        // setup 不装 assets（它 1–2 GB，且跨实例共享）。但必须提醒一句，
        // 否则用户会以为「setup 完成 = 能玩了」，然后崩在标题画面（issue #2）
        const warn = assetsIncompleteHint(
          probeAssets(
            layout.assets,
            gameVersionOf(versionId) ?? versionId,
            readAssetIndexId(layout.versionJson(versionId)),
          )?.probe ?? null,
          versionId,
        )
        if (warn !== undefined) say(`  ${C.yellow}!${C.reset} ${warn}\n`)
        say('\n')
      },
    },
    ctx.signal,
  )
}
