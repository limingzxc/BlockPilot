/**
 * 实例配置用例：layout → config 的唯一读取点。
 *
 * 命令不再直接依赖 `core/instance/config`；将来配置格式或默认值变化时，
 * 只需改这里。
 */

import { readConfig } from '../../core/instance/config.js'
import type { CommandContext } from '../command/context.js'

export function instanceConfig(ctx: CommandContext): ReturnType<typeof readConfig> {
  return readConfig(ctx.layout.gameDir)
}
