import { resolve } from 'node:path'
import { createInstaller } from '../../core/download/index.js'
import { detectHost } from '../../core/host.js'
import { createPreflight } from '../../core/preflight/index.js'
import { resolveCurseforge } from '../../sources/curseforge.js'
import { MODRINTH_API_MCIM, ModrinthSource } from '../../sources/modrinth.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA } from '../common-flags.js'
import { renderHuman } from '../render/preflight.js'
import { positional } from '../shared.js'
import { C, consume, consumeValue, humanBytes, say } from '../ui.js'

export const cmdInstall = defineCommand({
  name: 'install',
  positional: '<target>',
  summary: '先预检，再把 plan.installs 里的文件下载到 --mods-dir',
  flags: {
    '--mods-dir': { takesValue: true, value: '<dir>', required: true, help: '装到哪个 mods 目录' },
    '--dry-run': '只打印计划，不下载',
    '--include-unverified': '连「未验证」的依赖一起装',
    '--no-host': '跳过本机 Java / 内存检测（省 1–3 秒）',
    '--china': CHINA,
  },
  notes: ['整合包可能把依赖打在 jar-in-jar 里，未验证项默认不装（ADR-0025）'],
  run: runInstall,
})

export async function runInstall(ctx: CommandContext): Promise<number> {
  const target = positional(ctx)
  const modsDirArg = ctx.value('--mods-dir')
  // validateFlags 已经拦过缺 --mods-dir；这里只是给类型收窄
  if (target === undefined || modsDirArg === undefined) {
    ctx.usage()
    return 1
  }
  const dryRun = ctx.has('--dry-run')
  const includeUnverified = ctx.has('--include-unverified')

  process.stderr.write(`${C.dim}· preflight${C.reset}\n`)
  const host = ctx.has('--no-host') ? undefined : await detectHost({ root: ctx.root })
  const preflight = createPreflight({
    target,
    source: new ModrinthSource(ctx.china ? { apiBase: MODRINTH_API_MCIM } : {}),
    ...(host === undefined ? {} : { host }),
    curseforge: resolveCurseforge(),
  })
  // 还有安装步骤要跑；exit 留给整条命令结束时写
  const { code: preflightCode, value: report } = await consumeValue(
    preflight,
    { progress: () => {}, log: () => {}, exitEvent: false },
    ctx.signal,
  )
  if (preflightCode !== 0 || report === undefined) return 1

  say(renderHuman(report))

  const installs = report.plan.installs.filter(
    (i) => includeUnverified || i.confidence === 'verified',
  )
  const heldBack = report.plan.installs.length - installs.length
  if (installs.length === 0) {
    say(`${C.green}没有需要自动补装的东西。${C.reset}\n`)
    if (heldBack > 0) {
      say(
        `${C.dim}有 ${heldBack} 个依赖未验证（整合包可能用 jar-in-jar 内置了它们）。` +
          `确认缺再装：加 --include-unverified${C.reset}\n`,
      )
    }
    say('\n')
    // 本命令只对「装」负责：没有要补的依赖就是成功，哪怕预检因为宿主机没 Java 判了
    // BLOCKED（那是「能不能跑」的问题，归 preflight / run 管）。预检结论照旧打印在上面；
    // 脚本要按它判定，用 `preflight --json`。
    if (report.verdict === 'blocked' || report.verdict === 'unknown') {
      say(
        `${C.dim}预检结论 ${report.verdict} 说的是「这包能不能跑」，不影响本命令的退出码。${C.reset}\n\n`,
      )
    }
    return 0
  }

  // resolve 而不是 join：README 的示例是绝对路径，join 会拼成 <cwd>/D:/mc/...
  const modsDir = resolve(modsDirArg)
  const totalBytes = installs.reduce((s, i) => s + i.size, 0)
  say(
    `${C.bold}开始安装${C.reset}  ${installs.length} 个文件 · ${humanBytes(totalBytes)} → ${modsDir}\n\n`,
  )

  if (dryRun) {
    say(`${C.yellow}--dry-run${C.reset}：只打印计划，不下载\n\n`)
    return 0
  }

  const installer = createInstaller({
    plan: { installs, manual: report.plan.manual },
    modsDir,
    sources: ctx.sources,
  })

  const installCode = await consume(
    installer,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}      `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        if (ev.code === 'download.ok') {
          process.stderr.write(
            `\r${C.green}↓${C.reset} ${ev.data.file}  ${C.dim}${humanBytes(ev.data.bytes)} · ${ev.data.source}${C.reset}\n`,
          )
        } else if (ev.code === 'download.cached') {
          process.stderr.write(
            `\r${C.cyan}=${C.reset} ${ev.data.file}  ${C.dim}已存在且校验通过${C.reset}\n`,
          )
        } else if (ev.code === 'download.failed') {
          process.stderr.write(
            `\r${C.red}✗${C.reset} ${ev.data.file}  ${C.dim}${ev.data.error}${C.reset}\n`,
          )
        }
      },
      exitCode: (result) => (result.failed.length > 0 ? 2 : 0),
      result: (result) => {
        say('\n')
        say(
          `  ${C.green}完成${C.reset} ${result.downloaded.length} 个，` +
            `${result.failed.length > 0 ? C.red : C.dim}失败 ${result.failed.length} 个${C.reset}，` +
            `共 ${humanBytes(result.totalBytes)}\n`,
        )
        for (const f of result.failed) {
          say(`  ${C.red}✗${C.reset} ${f.fileName}  ${C.dim}${f.error}${C.reset}\n`)
        }

        // BMCLAPI 的协议要求在可视部分标明来源，所以这一行不是可选装饰。
        const credits = [
          ...new Set(result.downloaded.map((d) => d.credit).filter((c) => c !== undefined)),
        ]
        if (credits.length > 0) {
          say(`  ${C.dim}资源来源：${credits.join('、')}${C.reset}\n`)
        }
        const drifted = result.downloaded.filter((d) => d.sizeMismatch === true).length
        if (drifted > 0) {
          say(`  ${C.dim}${drifted} 个文件的索引体积与实际不符，已按哈希接受${C.reset}\n`)
        }
        say('\n')
      },
    },
    ctx.signal,
  )
  return installCode
}
