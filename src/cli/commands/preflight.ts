import { detectHost } from '../../core/host.js'
import { createPreflight } from '../../core/preflight/index.js'
import { resolveCurseforge } from '../../sources/curseforge.js'
import { MODRINTH_API_MCIM, ModrinthSource } from '../../sources/modrinth.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA } from '../common-flags.js'
import { renderHuman, verdictExit } from '../render/preflight.js'
import { positional } from '../shared.js'
import { consume, say } from '../ui.js'

export const cmdPreflight = defineCommand({
  name: 'preflight',
  positional: '<target>',
  summary: '预检一个整合包或实例目录：MC 版本、加载器、依赖、Java、assets',
  flags: {
    '--json': '输出结构化报告',
    '--no-host': '跳过本机 Java / 内存检测（省 1–3 秒）',
    '--no-cf-mirror': '禁用镜像回落，CF 包只做 Java/加载器这一层',
    '--china': CHINA,
  },
  notes: ['CurseForge 包免 key：没 key 时自动走 MCIM 镜像解析文件元数据'],
  run: runPreflight,
})

export async function runPreflight(ctx: CommandContext): Promise<number> {
  const target = positional(ctx)
  if (target === undefined) {
    ctx.usage()
    return 1
  }
  const asJson = ctx.has('--json')
  const host = ctx.has('--no-host') ? undefined : await detectHost({ root: ctx.root })
  const op = createPreflight({
    target,
    source: new ModrinthSource(ctx.china ? { apiBase: MODRINTH_API_MCIM } : {}),
    ...(host === undefined ? {} : { host }),
    // core 只认契约，具体走官方还是镜像由消费者注入（ADR-0001 / ADR-0040）
    curseforge: resolveCurseforge(ctx.has('--no-cf-mirror') ? { allowMirror: false } : {}),
  })

  return consume(
    op,
    {
      ...(asJson ? { progress: () => {}, log: () => {} } : {}),
      exitCode: (report) => verdictExit(report.verdict),
      result: (report) => {
        if (asJson) say(`${JSON.stringify(report, null, 2)}\n`)
        else say(renderHuman(report))
      },
    },
    ctx.signal,
  )
}
