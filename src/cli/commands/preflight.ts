import { createContentSources } from '../../assembly.js'
import { detectHost } from '../../core/host/index.js'
import { createPreflight } from '../../core/preflight/index.js'
import { CHINA } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { say } from '../output/stream.js'
import { renderHuman, verdictExit } from '../render/preflight.js'
import { positional } from '../shared/args.js'

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
  const content = createContentSources({
    china: ctx.china,
    allowCfMirror: !ctx.has('--no-cf-mirror'),
  })
  const op = createPreflight({
    target,
    source: content.modrinth,
    ...(host === undefined ? {} : { host }),
    // core 只认契约，具体走官方还是镜像由消费者注入（ADR-0001 / ADR-0040）
    curseforge: content.curseforge,
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
