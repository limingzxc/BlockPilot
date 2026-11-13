import { createContentSources } from '../../assembly.js'
import { updateLoader } from '../../core/instance/loader-update.js'
import { readLock } from '../../core/instance/lock.js'
import type { UpdateCheckResult } from '../../core/instance/update.js'
import { checkUpdates } from '../../core/instance/update.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { renderJavaFailure } from '../render/java.js'
import { instanceConfig } from '../use-cases/instance.js'
import { pickJava } from '../use-cases/java.js'
import { installLoader, loaderNeedsJava } from '../use-cases/loader.js'

export const cmdUpdate = defineCommand({
  name: 'update',
  summary: '按 lock.json 检查模组更新；加 --apply 才会下载替换',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--apply': '下载并替换到新版本（会删除旧 jar；默认只检查）',
    '--loader': '只升级加载器到最新兼容版，不检查模组',
    '--java': { takesValue: true, value: '<path>', help: '升级 Forge 时跑 installer 用的 java' },
    '--china': CHINA,
    '--no-cf-mirror': '禁用 CurseForge 镜像回落',
    '--json': '输出 JSON',
  },
  notes: [
    'Modrinth 走官方接口；CurseForge 有 key 走官方，没有走 MCIM 镜像',
    '替换顺序：下载校验 → 删旧文件 → 写 lock；任一步失败都保留旧文件',
    '--loader 只动加载器；NeoForge 从 maven-metadata 选最新构建',
  ],
  run: runUpdate,
})

export function renderUpdate(r: UpdateCheckResult, gameDir: string): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot update${C.reset}  ${C.dim}${gameDir}${C.reset}`)
  lines.push('')
  lines.push(
    `  清单 ${r.lock.files.length} 个 · 可检查 ${r.checked} · 已最新 ${r.upToDate} · ` +
      `${r.updates.length > 0 ? C.yellow : C.green}可更新 ${r.updates.length}${C.reset} · ` +
      `跳过 ${r.skipped} · 失败 ${r.failed.length}`,
  )
  lines.push('')

  for (const u of r.updates) {
    lines.push(`  ${C.green}↑${C.reset} ${u.path}`)
    lines.push(`    ${C.dim}${u.name} · ${u.from} → ${u.to}${C.reset}`)
  }
  if (r.updates.length > 0 && r.applied.length === 0) {
    lines.push('')
    lines.push(`  ${C.dim}只检查，未改动文件。加 --apply 才会下载替换${C.reset}`)
  }
  for (const a of r.applied) {
    lines.push(
      `  ${C.green}✓${C.reset} ${a.path} → ${a.newPath === a.path ? '同名覆盖' : a.newPath}`,
    )
  }
  for (const f of r.applyFailed.slice(0, 10)) {
    lines.push(`  ${C.red}✗${C.reset} ${f.path}  ${C.dim}${f.error}${C.reset}`)
  }
  for (const f of r.failed.slice(0, 10)) {
    lines.push(`  ${C.yellow}!${C.reset} ${f.path}  ${C.dim}${f.error}${C.reset}`)
  }
  if (r.failed.length > 10) lines.push(`  ${C.dim}…还有 ${r.failed.length - 10} 个失败${C.reset}`)
  lines.push('')
  return lines.join('\n')
}

export async function runLoaderUpdate(ctx: CommandContext): Promise<number> {
  const layout = ctx.layout
  const asJson = ctx.has('--json')
  const lock = readLock(layout.gameDir)
  if (lock === null) {
    process.stderr.write(
      `${C.red}没有 lock.json${C.reset}：${layout.gameDir}\n` +
        `${C.dim}先 deploy 一次；--loader 需要知道当前加载器版本${C.reset}\n`,
    )
    return 1
  }

  const { kind, version } = lock.target.loader
  // 只有 installer 型加载器要 Java；Deploy 也要在下载原版前回答同一个问题
  const needsJava = loaderNeedsJava(kind)
  let javaPath: string | undefined
  if (needsJava) {
    const java = await pickJava(
      lock.target.gameVersion,
      layout,
      ctx.signal,
      ctx.value('--java') ?? instanceConfig(ctx).javaPath,
    )
    if (!java.ok) {
      renderJavaFailure(java)
      return 1
    }
    javaPath = java.path
  }

  const setup = installLoader(ctx, {
    kind,
    gameVersion: lock.target.gameVersion,
    ...(javaPath === undefined ? {} : { java: javaPath }),
    ...(ctx.proxy === undefined ? {} : { proxy: ctx.proxy }),
  })

  say('\n')
  say(`  ${C.dim}加载器${C.reset}  ${kind} ${version}\n\n`)

  return consume(
    updateLoader({ gameDir: layout.gameDir, setup }),
    {
      progress: () => {},
      log: () => {},
      exitCode: () => 0,
      result: (r) => {
        if (asJson) {
          say(`${JSON.stringify(r, null, 2)}\n`)
        } else {
          say(
            `  ${C.green}已升级${C.reset}  ${r.from} → ${r.to}  ${C.dim}${r.versionId}${C.reset}\n`,
          )
          if (r.versionJsonPath !== undefined) {
            say(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
          }
          say('\n')
        }
      },
    },
    ctx.signal,
  )
}

export async function runUpdate(ctx: CommandContext): Promise<number> {
  if (ctx.has('--loader')) return runLoaderUpdate(ctx)
  const layout = ctx.layout
  const asJson = ctx.has('--json')
  const content = createContentSources({
    china: ctx.china,
    allowCfMirror: !ctx.has('--no-cf-mirror'),
  })
  const resolver = content.modrinth
  // ADR-0029：key 只从环境变量 BLOCKPILOT_CF_API_KEY 读，不接受命令行参数（会进 shell history）
  return consume(
    checkUpdates({
      gameDir: layout.gameDir,
      resolver,
      versionSource: resolver,
      cfResolver: content.curseforge,
      ...(ctx.has('--apply') ? { apply: true } : {}),
      sources: ctx.sources,
    }),
    {
      progress: () => {},
      log: () => {},
      exitCode: (r) =>
        r.applyFailed.length > 0 ? 2 : r.applied.length === 0 && r.updates.length > 0 ? 2 : 0,
      result: (r) => {
        if (asJson) say(`${JSON.stringify(r, null, 2)}\n`)
        else say(renderUpdate(r, layout.gameDir))
      },
    },
    ctx.signal,
  )
}
