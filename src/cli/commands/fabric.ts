import { runHint } from '../../core/hints.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { downloadRenderer } from '../render/download.js'
import { positional } from '../shared/args.js'
import { installLoader } from '../use-cases/loader.js'

export const cmdFabric = defineCommand({
  name: 'fabric',
  positional: '<gameVersion>',
  summary: '安装 Fabric：取 profile → 写版本 JSON → 下载 loader 库',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--loader': { takesValue: true, value: '<ver>', help: '指定 loader 版本；缺省取最新兼容版' },
    '--legacy': '强制走 Legacy Fabric，不做自动探测',
    '--china': CHINA,
  },
  notes: ['1.6.x / 1.7.10 / 1.12.2 只有 Legacy Fabric 有 loader，缺省自动探测（ADR-0035）'],
  run: runFabric,
})

export async function runFabric(ctx: CommandContext): Promise<number> {
  const gameVersion = positional(ctx)
  if (gameVersion === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const loader = ctx.value('--loader')

  say('\n')
  say(`  ${C.dim}root${C.reset}  ${layout.root}\n`)
  say(`  ${C.dim}游戏版本${C.reset}  ${gameVersion}\n\n`)

  const op = installLoader(ctx, {
    kind: 'fabric',
    gameVersion,
    ...(loader === undefined ? {} : { loaderVersion: loader }),
    ...(ctx.has('--legacy') ? { legacy: true } : {}),
  })

  const downloads = downloadRenderer(
    { ok: 'fabric.ok', cached: 'fabric.cached', failed: 'fabric.failed' },
    { label: '下载' },
  )

  return consume(
    op,
    {
      progress: downloads.progress,
      log: (ev) => {
        if (ev.code === 'fabric.ok' || ev.code === 'fabric.cached' || ev.code === 'fabric.failed') {
          downloads.log(ev)
          return
        }
        if (ev.code === 'fabric.legacy') {
          process.stderr.write(
            `${C.yellow}!${C.reset} ${gameVersion} 没有官方 Fabric，改用 Legacy Fabric\n`,
          )
        } else if (ev.code === 'fabric.natives') {
          process.stderr.write(`${C.dim}· 原生库 ${ev.data.extracted} 个${C.reset}\n`)
        } else if (ev.code === 'fabric.profile') {
          process.stderr.write(`${C.dim}· profile ${ev.data.id}${C.reset}\n`)
        } else if (ev.code === 'fabric.no_hash') {
          process.stderr.write(
            `${C.yellow}!${C.reset} ${ev.data.count} 个库拿不到 sha1，跳过不下载：${ev.data.libs.join(', ')}\n`,
          )
        }
      },
      exitCode: (r) => (r.failed.length > 0 ? 2 : 0),
      result: (r) => {
        say('\n')
        const stats =
          r.detail.kind === 'profile'
            ? ` · ${r.detail.libraries} 个库 · 下载 ${r.detail.downloaded} · 跳过 ${r.detail.skipped} · 失败 ${r.failed.length}` +
              `${r.detail.nativesExtracted > 0 ? ` · 原生库 ${r.detail.nativesExtracted} 个` : ''}`
            : ''
        say(`  ${C.green}完成${C.reset} loader ${r.loaderVersion}${stats}\n`)
        say(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
        say(
          `\n  ${C.bold}启动${C.reset}  ${runHint(r.versionId, layout.root, layout.instanceId)}\n\n`,
        )
      },
    },
    ctx.signal,
  )
}
