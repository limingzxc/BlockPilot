/**
 * 子命令的声明与上下文。
 *
 * 一条子命令的 interface 有三个消费者：`validateFlags`、`--help`、分发。
 * 以前它们各自维护一份名单——`flags.ts` 一张表、`usage()` 一段手写文本、
 * 每个 handler 里若干次 `argOf`——于是帮助里「CurseForge 包只能预检版本与 Java，
 * mod 级校验要 API key」在 ADR-0036 之后仍然留着，README 早就改成免 key 了。
 *
 * 现在一处声明（`defineCommand`），校验与帮助都从它派生；handler 只领取解析好的
 * 上下文，不再各自拼 root/instance/layout/sources/signal。
 */

import { pickSources } from '../core/download/sources.js'
import type { DownloadSource } from '../core/download/types.js'
import { defaultRoot, resolveLayout } from '../core/layout.js'
import type { Layout } from '../core/layout.js'
import { normalizeFlags } from './flags.js'
import type { FlagDecl, FlagSpec } from './flags.js'

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
 * 子命令 + 解析好的上下文 = handler 需要的全部输入。
 *
 * `layout` 与 `sources` 是惰性的：`preflight` / `install` 只认一个路径，
 * 它们不该因为「默认根目录恰好是个文件」而在解析布局这一步失败。
 */
export interface CommandContext {
  /** 子命令之后的参数（含 flag）。位置参数是 `argv[0]` */
  readonly argv: readonly string[]
  readonly signal: AbortSignal
  /** 全局 `--proxy` 解析出的地址。只有要传给子进程的地方用得上 */
  readonly proxy?: string
  /** `--root`，缺省见 defaultRoot() */
  readonly root: string
  /** `--instance`，缺省 default */
  readonly instance: string
  readonly layout: Layout
  /** 本次调用的下载源顺序：`--china` 时镜像在前 */
  readonly sources: readonly DownloadSource[]
  readonly china: boolean
  has(flag: string): boolean
  /** flag 后面那个值 */
  value(flag: string): string | undefined
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

class Ctx implements CommandContext {
  readonly argv: readonly string[]
  readonly signal: AbortSignal
  readonly proxy: string | undefined
  readonly root: string
  readonly instance: string
  private cachedLayout: Layout | undefined
  private cachedSources: readonly DownloadSource[] | undefined

  constructor(argv: readonly string[], signal: AbortSignal, proxy: string | undefined) {
    this.argv = argv
    this.signal = signal
    this.proxy = proxy
    this.root = argOf(argv, '--root') ?? defaultRoot()
    this.instance = argOf(argv, '--instance') ?? 'default'
  }

  get layout(): Layout {
    this.cachedLayout ??= resolveLayout(this.root, this.instance)
    return this.cachedLayout
  }

  get sources(): readonly DownloadSource[] {
    this.cachedSources ??= pickSources(this.china)
    return this.cachedSources
  }

  get china(): boolean {
    return this.argv.includes('--china')
  }

  has(flag: string): boolean {
    return this.argv.includes(flag)
  }

  value(flag: string): string | undefined {
    return argOf(this.argv, flag)
  }
}

export function createContext(input: {
  readonly argv: readonly string[]
  readonly signal: AbortSignal
  readonly proxy?: string
}): CommandContext {
  return new Ctx(input.argv, input.signal, input.proxy)
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
  if (spec.positional !== undefined && !spec.positional.startsWith('<') && !spec.positional.startsWith('[')) {
    throw new Error(`${spec.name}: positional 要写成 '<x>' 或 '[x]'，收到 ${spec.positional}`)
  }
  return { ...spec, flags }
}

function label(flag: string, f: FlagSpec): string {
  const text = f.takesValue ? `${flag} ${f.value ?? ''}` : flag
  return f.required === true ? text : `[${text}]`
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

/** 用法总览里的一行。 */
export function synopsis(c: Command): string {
  const parts = [`blockpilot ${c.name}`]
  if (c.positional !== undefined) parts.push(c.positional)
  for (const [flag, f] of Object.entries(c.flags)) parts.push(label(flag, f))
  return parts.join(' ')
}

/**
 * `--help` 的全文。
 *
 * 结构：用法 → 通用 flag → 共享概念（`<target>`）→ 每条命令的说明与自己的 flag。
 * 通用 flag 只解释一次：`--root` 出现在十条命令里，逐个重复只会把帮助撑长。
 */
export function usageText(commands: readonly Command[]): string {
  const lines: string[] = []
  lines.push('BlockPilot — AI-drivable launcher core')
  lines.push('')
  lines.push('  用法：blockpilot <命令> [位置参数] [flag]')
  lines.push('')

  // 通用 flag：按第一次出现的顺序去重
  const common = new Map<string, FlagSpec>()
  for (const c of commands) {
    for (const [flag, f] of Object.entries(c.flags)) {
      if (f.common === true && !common.has(flag)) common.set(flag, f)
    }
  }
  const commonRows = [...common.entries()].map(([flag, f]) => ({
    label: f.takesValue ? `${flag} ${f.value ?? ''}` : flag,
    help: f.help ?? '',
  }))
  commonRows.push({ label: '--proxy <url>', help: '走 HTTP 代理（也读 HTTPS_PROXY 环境变量），影响元数据、下载与 installer' })

  lines.push('  通用：')
  for (const row of commonRows) {
    const width = Math.max(...commonRows.map((r) => r.label.length))
    lines.push(`    ${pad(row.label, width)}  ${row.help}`)
  }
  lines.push('')
  lines.push('  <target>  .mrpack / CurseForge 的 zip（带 manifest.json），或实例目录')
  lines.push('            （MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录）')
  lines.push('')

  for (const c of commands) {
    lines.push(`  ${synopsis(c)}`)
    lines.push(`      ${c.summary}`)

    const rows = Object.entries(c.flags)
      .filter(([, f]) => f.common !== true)
      .map(([flag, f]) => ({
        label: f.takesValue ? `${flag} ${f.value ?? ''}` : flag,
        help: f.help ?? '',
      }))
    if (rows.length > 0) {
      const width = Math.max(...rows.map((r) => r.label.length))
      for (const row of rows) lines.push(`      ${pad(row.label, width)}  ${row.help}`)
    }
    for (const note of c.notes ?? []) lines.push(`      ${note}`)
    lines.push('')
  }

  return lines.join('\n')
}
