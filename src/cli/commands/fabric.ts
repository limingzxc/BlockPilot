import { runHint } from '../../core/hints.js'
import { createFabricSetup } from '../../core/setup/fabric.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA, INSTANCE, ROOT } from '../common-flags.js'
import { positional, usage } from '../shared.js'
import { C, consume, say } from '../ui.js'

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
    usage()
    return 1
  }
  const layout = ctx.layout
  const loader = ctx.value('--loader')
  const china = ctx.china

  say('\n')
  say(`  ${C.dim}root${C.reset}  ${layout.root}\n`)
  say(`  ${C.dim}游戏版本${C.reset}  ${gameVersion}\n\n`)

  const op = createFabricSetup({
    layout,
    gameVersion,
    ...(loader === undefined ? {} : { loaderVersion: loader }),
    ...(ctx.has('--legacy') ? { legacy: true } : {}),
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
        if (ev.code === 'fabric.legacy') {
          process.stderr.write(
            `${C.yellow}!${C.reset} ${gameVersion} 没有官方 Fabric，改用 Legacy Fabric\n`,
          )
        } else if (ev.code === 'fabric.natives') {
          process.stderr.write(`${C.dim}· 原生库 ${ev.data.extracted} 个${C.reset}\n`)
        } else if (ev.code === 'fabric.profile') {
          process.stderr.write(`${C.dim}· profile ${ev.data.id}${C.reset}\n`)
        } else if (ev.code === 'fabric.ok') {
          process.stderr.write(
            `\r${C.green}↓${C.reset} ${ev.data.file}  ${C.dim}${ev.data.source}${C.reset}\n`,
          )
        } else if (ev.code === 'fabric.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${ev.data.file}  ${ev.data.error}\n`)
        } else if (ev.code === 'fabric.no_hash') {
          process.stderr.write(
            `${C.yellow}!${C.reset} ${ev.data.count} 个库拿不到 sha1，跳过不下载：${ev.data.libs.join(', ')}\n`,
          )
        }
      },
      exitCode: (r) => (r.failed.length > 0 ? 2 : 0),
      result: (r) => {
        say('\n')
        say(
          `  ${C.green}完成${C.reset} loader ${r.loaderVersion} · ${r.libraries} 个库 · ` +
            `下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length}` +
            `${r.nativesExtracted > 0 ? ` · 原生库 ${r.nativesExtracted} 个` : ''}\n`,
        )
        say(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
        say(
          `\n  ${C.bold}启动${C.reset}  ${runHint(r.versionId, layout.root, layout.instanceId)}\n\n`,
        )
        return r.failed.length > 0 ? 2 : 0
      },
    },
    ctx.signal,
  )
}
