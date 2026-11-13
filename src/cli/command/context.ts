/**
 * 子命令上下文：handler 需要的全部输入。
 *
 * `layout` 与 `sources` 是惰性的：`preflight` / `install` 只认一个路径，
 * 它们不该因为「默认根目录恰好是个文件」而在解析布局这一步失败。
 */
import { pickSources } from '../../core/download/mirrors.js'
import type { Mirror } from '../../core/download/types.js'
import type { Layout } from '../../core/layout.js'
import { defaultRoot, resolveLayout } from '../../core/layout.js'
import type { FlagSpec } from './flags.js'

export interface CommandContext {
  /** 子命令之后的参数（含 flag） */
  readonly argv: readonly string[]
  /** 本条命令的 flag 声明。`positional()` 靠它跳过「flag + 值」 */
  readonly flags: Readonly<Record<string, FlagSpec>>
  readonly signal: AbortSignal
  /** 全局 `--proxy` 解析出的地址。只有要传给子进程的地方用得上 */
  readonly proxy?: string | undefined
  /** `--root`，缺省见 defaultRoot() */
  readonly root: string
  /** `--instance`，缺省 default */
  readonly instance: string
  readonly layout: Layout
  /** 本次调用的下载源顺序：`--china` 时镜像在前 */
  readonly sources: readonly Mirror[]
  readonly china: boolean
  has(flag: string): boolean
  /** flag 后面那个值 */
  value(flag: string): string | undefined
  /** 缺位置参数时打印全局用法。由入口注入，命令模块不依赖模块级可变状态 */
  usage(): void
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

class Ctx implements CommandContext {
  readonly argv: readonly string[]
  readonly flags: Readonly<Record<string, FlagSpec>>
  readonly signal: AbortSignal
  readonly proxy: string | undefined
  readonly root: string
  readonly instance: string
  readonly usage: () => void
  private cachedLayout: Layout | undefined
  private cachedSources: readonly Mirror[] | undefined

  constructor(
    argv: readonly string[],
    flags: Readonly<Record<string, FlagSpec>>,
    signal: AbortSignal,
    proxy: string | undefined,
    usage: () => void,
  ) {
    this.argv = argv
    this.flags = flags
    this.signal = signal
    this.proxy = proxy
    this.usage = usage
    this.root = argOf(argv, '--root') ?? defaultRoot()
    this.instance = argOf(argv, '--instance') ?? 'default'
  }

  get layout(): Layout {
    this.cachedLayout ??= resolveLayout(this.root, this.instance)
    return this.cachedLayout
  }

  get sources(): readonly Mirror[] {
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
  readonly flags: Readonly<Record<string, FlagSpec>>
  readonly signal: AbortSignal
  readonly proxy?: string
  readonly usage: () => void
}): CommandContext {
  return new Ctx(input.argv, input.flags, input.signal, input.proxy, input.usage)
}
