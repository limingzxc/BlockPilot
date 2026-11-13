/**
 * 子命令声明：形状、校验、派生。
 *
 * 一条子命令的 interface 有三个消费者：`validateFlags`、`--help`、分发。
 * 一处声明（`defineCommand`），校验与帮助都从它派生；handler 只领取解析好的
 * 上下文，不再各自拼 root/instance/layout/sources/signal。
 */

import type { CommandContext } from './context.js'
import type { FlagDecl, FlagSpec } from './flags.js'
import { normalizeFlags } from './flags.js'

/** 声明一条子命令时写的东西。位置参数只用于帮助；handler 从 `ctx.argv` 取。 */
export interface CommandSpec {
  readonly name: string
  /** 用法里的位置参数写法，如 `<target>`。没有就省略 */
  readonly positional?: string
  /** 一段话说明这条命令做什么，进 `--help` */
  readonly summary: string
  readonly flags: Readonly<Record<string, FlagDecl>>
  /** 只属于这条命令的补充说明，一行一条 */
  readonly notes?: readonly string[]
  readonly run: (ctx: CommandContext) => Promise<number>
}

/** `defineCommand` 的产物：flag 已经归一化成一种形状。 */
export interface Command extends Omit<CommandSpec, 'flags'> {
  readonly flags: Readonly<Record<string, FlagSpec>>
}

/**
 * 声明一条命令。形状写错时在 import 阶段就炸——每条测试都会经过这里，
 * 不会等到用户敲 `--help` 才发现少了个占位符。
 */
export function defineCommand(spec: CommandSpec): Command {
  const flags = normalizeFlags(spec.flags)
  for (const [flag, f] of Object.entries(flags)) {
    if (!flag.startsWith('--')) throw new Error(`${spec.name}: flag 名要以 -- 开头：${flag}`)
    if (f.takesValue && f.value === undefined) {
      throw new Error(`${spec.name}: ${flag} 要取值，必须给 value 占位符，如 '<dir>'`)
    }
    if (!f.takesValue && f.value !== undefined) {
      throw new Error(`${spec.name}: ${flag} 不取值，不该有 value 占位符`)
    }
    if (f.help === undefined) throw new Error(`${spec.name}: ${flag} 缺 help，帮助里会是一条空行`)
  }
  if (
    spec.positional !== undefined &&
    !spec.positional.startsWith('<') &&
    !spec.positional.startsWith('[')
  ) {
    throw new Error(`${spec.name}: positional 要写成 '<x>' 或 '[x]'，收到 ${spec.positional}`)
  }
  return { ...spec, flags }
}
