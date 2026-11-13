/**
 * 命令行参数解析。
 *
 * 只做「把字符串变成有类型的值」，不组合用例、不渲染。
 */
import type { CommandContext } from '../command/context.js'
import { UsageError } from './errors.js'

/**
 * 第一个位置参数。
 *
 * 不能只看 `argv[0]`：`deploy --root D:/mc pack.mrpack` 是合法写法，
 * 以前会直接打印整篇用法。按 flag 声明跳过「flag + 它的值」，
 * 不取值的开关只跳自己。
 */
export function positional(ctx: CommandContext): string | undefined {
  for (let i = 0; i < ctx.argv.length; i += 1) {
    const arg = ctx.argv[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) return arg
    if (ctx.flags[arg]?.takesValue === true) i += 1
  }
  return undefined
}

/**
 * 解析 --memory。
 *
 * 用户会照教程填 8192、16384，也会手滑填 abc、-1、0。以前这些值原样拼成
 * `-XmxNaNM` / `-Xmx-1M` 传给 JVM，JVM 回一句 `Unrecognized option` 就退出——
 * 用户完全联想不到是自己参数写错了。
 */
export function parseMemoryArg(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined
  if (!/^\d+$/.test(arg)) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory 要一个整数（单位 MB），收到：${arg}`,
      '例：--memory 4096',
    )
  }
  const mib = Number(arg)
  if (mib < 512) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory ${mib} 太小，游戏起不来`,
      '至少 1024；大型整合包 4096 起',
    )
  }
  if (mib > 65536) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory ${mib} 超出合理范围`,
      '不要超过物理内存的一半；8192 / 16384 已经够大',
    )
  }
  return mib
}

/** `--stop` 要一个正数秒。`abc` 会变成 `setTimeout(NaN)`，游戏被立刻杀掉。 */
export function parseStopArg(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined
  if (!/^\d+(?:\.\d+)?$/.test(arg) || Number(arg) <= 0) {
    throw new UsageError('BAD_STOP', `--stop 要一个正数秒，收到：${arg}`, '例：--stop 60')
  }
  return Number(arg)
}

/** `--concurrency` 要一个正整数。`abc` 会让下载池宽度变成 NaN，一个文件都不下。 */
export function parseConcurrencyArg(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined
  if (!/^\d+$/.test(arg) || Number(arg) < 1 || Number(arg) > 64) {
    throw new UsageError(
      'BAD_CONCURRENCY',
      `--concurrency 要 1–64 的整数，收到：${arg}`,
      '例：--concurrency 8',
    )
  }
  return Number(arg)
}
