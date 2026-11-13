import { errMessage, isBlockPilotError } from '../../core/errors.js'
import { CHINA, INSTANCE, ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { consume } from '../consume/index.js'
import { deployUi, renderDeployFailure, renderDeployIntro } from '../render/deploy.js'
import { renderJavaFailure } from '../render/java.js'
import { positional } from '../shared/args.js'
import type { DeployAssembly } from '../use-cases/deploy.js'
import { assembleDeploy } from '../use-cases/deploy.js'

export const cmdDeploy = defineCommand({
  name: 'deploy',
  positional: '<包|slug>',
  summary: '一次装完：原版 → 加载器 → 模组 → overrides；也可传 Modrinth slug',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--china': CHINA,
    '--java': { takesValue: true, value: '<path>', help: '跑 Forge installer 用的 java' },
    '--no-cf-mirror': '禁用镜像回落，没 key 时只装加载器与 overrides',
    '--allow-host': {
      takesValue: true,
      value: '<host>',
      help: '额外允许的 mrpack 下载域名，逗号分隔（默认只允许 Modrinth 规范的域名）',
    },
    '--overwrite-overrides': '重跑时覆盖 overrides 里已存在的文件（会冲掉你改过的配置）',
  },
  notes: ['CurseForge 包不需要 key：没有 key 时走 MCIM 镜像逐个解析（ADR-0036）'],
  run: runDeploy,
})

export async function runDeploy(ctx: CommandContext): Promise<number> {
  const target = positional(ctx)
  if (target === undefined) {
    ctx.usage()
    return 1
  }

  let assembly: DeployAssembly
  try {
    assembly = await assembleDeploy(ctx, target)
  } catch (err) {
    renderDeployFailure(errMessage(err), isBlockPilotError(err) ? err.hint : undefined)
    return 1
  }

  renderDeployIntro({
    packPath: assembly.packPath,
    instance: assembly.instance,
    gameDir: assembly.layout.gameDir,
    ...(assembly.remote === undefined ? {} : { remote: assembly.remote }),
  })
  if (assembly.javaWarning !== undefined) renderJavaFailure(assembly.javaWarning)

  return consume(
    assembly.op,
    deployUi({ layout: assembly.layout, instance: assembly.instance }),
    ctx.signal,
  )
}
