import { runHint } from '../../core/hints.js'
import { createVanillaSetup } from '../../core/setup/vanilla.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { downloadRenderer } from '../render/download.js'
import { renderJavaFailure } from '../render/java.js'
import { positional } from '../shared/args.js'
import { instanceConfig } from '../use-cases/instance.js'
import { pickJava } from '../use-cases/java.js'
import { installLoader } from '../use-cases/loader.js'

export const cmdForge = defineCommand({
  name: 'forge',
  positional: '<gameVersion>',
  summary: '安装 Forge：先跑原版 setup（natives），再跑官方 installer',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--loader': { takesValue: true, value: '<ver>', help: '指定 Forge 版本；缺省取最新兼容版' },
    '--java': { takesValue: true, value: '<path>', help: '跑 installer 用的 java' },
    '--china': CHINA,
  },
  run: (ctx) => runForge(ctx, 'forge'),
})

export const cmdNeoforge = defineCommand({
  name: 'neoforge',
  positional: '<gameVersion>',
  summary: '同上，换 NeoForge',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--loader': { takesValue: true, value: '<ver>', help: '指定 NeoForge 版本；缺省取最新兼容版' },
    '--java': { takesValue: true, value: '<path>', help: '跑 installer 用的 java' },
    '--china': CHINA,
  },
  notes: ['installer 会换成镜像里的重打包版本，无代理也能装（ADR-0022）'],
  run: (ctx) => runForge(ctx, 'neoforge'),
})

/**
 * Forge / NeoForge 加载器。
 *
 * 与 `fabric` 对称，但多一步：Forge 的原生库要靠原版 setup 解压，否则
 * `run` 会报 `UnsatisfiedLinkError: Failed to locate library: lwjgl.dll`。
 * 所以先跑原版 setup（它同时把 version JSON 落盘，选 Java 才有依据），
 * 再跑官方 installer（issue #13）。
 */
export async function runForge(ctx: CommandContext, kind: 'forge' | 'neoforge'): Promise<number> {
  const gameVersion = positional(ctx)
  if (gameVersion === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const loader = ctx.value('--loader')
  const china = ctx.china

  say('\n')
  say(`  ${C.dim}root${C.reset}  ${layout.root}\n`)
  say(`  ${C.dim}游戏版本${C.reset}  ${gameVersion} + ${kind}\n\n`)

  // ---- 1. 原版：client jar / libraries / natives ----
  const vanillaDownloads = downloadRenderer(
    { ok: 'setup.ok', cached: 'setup.cached', failed: 'setup.failed' },
    // 原版文件几百个，逐条成功会刷屏；失败要逐条说清楚
    { label: '原版', quiet: true },
  )
  const vanillaCode = await consume(
    createVanillaSetup({
      layout,
      versionId: gameVersion,
      sources: ctx.sources,
      mirror: china,
    }),
    {
      progress: vanillaDownloads.progress,
      log: vanillaDownloads.log,
      // installer 是下一步；exit 留给它
      exitEvent: false,
      exitCode: (r) => (r.failed.length > 0 ? 2 : 0),
      result: (r) => {
        say(
          `  ${C.green}原版就绪${C.reset}  下载 ${r.downloaded} · 跳过 ${r.skipped} · 原生库 ${r.nativesExtracted} 个\n`,
        )
      },
    },
    ctx.signal,
  )
  if (vanillaCode !== 0) return vanillaCode

  // ---- 2. installer。它要一个能跑的 JVM，所以原版 JSON 落盘之后再选 Java ----
  const config = instanceConfig(ctx)
  const java = await pickJava(
    gameVersion,
    layout,
    ctx.signal,
    ctx.value('--java') ?? config.javaPath,
  )
  if (!java.ok) {
    renderJavaFailure(java)
    return 1
  }
  const javaPath = java.path

  const op = installLoader(ctx, {
    kind,
    gameVersion,
    java: javaPath,
    ...(loader === undefined ? {} : { loaderVersion: loader }),
    ...(ctx.proxy === undefined ? {} : { proxy: ctx.proxy }),
  })

  return consume(
    op,
    {
      progress: () => {},
      log: (ev) => {
        if (ev.code === 'forge.already_installed') {
          process.stderr.write(`${C.dim}· 已装过 ${ev.data.versionId}${C.reset}\n`)
        }
      },
      exitCode: () => 0,
      result: (r) => {
        const via =
          r.detail.kind === 'installer'
            ? r.detail.installerRan
              ? '已跑官方 installer'
              : '复用已有安装'
            : ''
        say('\n')
        say(`  ${C.green}完成${C.reset} ${kind} ${r.loaderVersion} · ${via}\n`)
        say(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
        say(
          `\n  ${C.bold}启动${C.reset}  ${runHint(r.versionId, layout.root, layout.instanceId)}\n\n`,
        )
      },
      failed: (ev) => {
        process.stderr.write(`\n${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
      },
    },
    ctx.signal,
  )
}
