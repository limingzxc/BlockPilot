import { join } from 'node:path'
import { createCredentialStore } from '../core/auth/credentials.js'
import { authStorePath, isAuthError, resolveAccount } from '../core/auth/index.js'
import type { AuthAccount } from '../core/auth/types.js'
import { BlockPilotError } from '../core/errors.js'
import { javaInstallHint } from '../core/hints.js'
import { selectJava } from '../core/java/select.js'
import type { Layout } from '../core/layout.js'
import type { CommandContext } from './commands.js'
import { C } from './ui.js'

/** 命令行参数不合法。给稳定 code，别让用户看到 `unexpected error: Error: ...`。 */
export class UsageError extends BlockPilotError {
  constructor(code: string, message: string, hint?: string) {
    super(code, message, hint === undefined ? {} : { hint })
    this.name = 'UsageError'
  }
}

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

/**
 * 离线用户名的合法性提示（不阻断）。
 *
 * MC 的离线名只认字母、数字、下划线，长度 1–16。中文名单机能进，但联机时
 * 服务端会拒绝或显示乱码——这是新手最常踩的坑之一，网上的教程都会特意提醒。
 * 单人确实能玩，所以只提醒，不拦。
 */
export function warnOfflineUsername(name: string): void {
  if (/^[A-Za-z0-9_]{1,16}$/.test(name)) return
  process.stderr.write(
    `${C.yellow}注意${C.reset}：离线用户名「${name}」不符合规则（仅字母/数字/下划线，1–16 位），联机会被拒\n` +
      `${C.dim}单人还能进；要联机请换成英文名，如 Steve${C.reset}\n`,
  )
}

/** 三个子命令共用「挑 Java」用例；core 负责选，这里只渲染结局。 */
export async function pickJavaOrReport(
  versionId: string | undefined,
  layout: Layout,
  signal: AbortSignal,
  explicit: string | undefined,
): Promise<string | undefined> {
  const outcome = await selectJava({
    ...(versionId === undefined ? {} : { versionId }),
    layoutRoot: layout.root,
    // 传整个 layout：只有它能读到 versions/<id>/<id>.json 里的 javaVersion
    layout,
    signal,
    ...(explicit === undefined ? {} : { explicit }),
  })
  if (outcome.ok) return outcome.path
  process.stderr.write(`${C.red}${outcome.message}${C.reset}\n`)
  // 只说「没有」而不说怎么办，用户下一步只能去搜。给一条能直接敲的命令
  if (outcome.needMajor !== undefined) {
    process.stderr.write(`${C.dim}可以装一个：${javaInstallHint(outcome.needMajor)}${C.reset}\n`)
  }
  return undefined
}

/**
 * 为启动挑账号。
 *
 * 三种情况分开处理，因为「用户此刻想要什么」不同：
 *   --offline     明确要离线，不问存档
 *   有存档        用它（过期就自动刷新）
 *   没存档        离线，并在 stderr 说明一句
 *
 * 点名要 `--account` 却拿不到时退出码非零：他要的是在线身份，
 * 悄悄用离线身份进去，朋友会看到「这不是你」。
 */
export async function resolveAuth(
  ctx: CommandContext,
): Promise<{ ok: true; account?: AuthAccount } | { ok: false }> {
  if (ctx.has('--offline')) return { ok: true }

  const selector = ctx.value('--account')
  try {
    const r = await resolveAccount({
      storePath: authStorePath(ctx.layout.root),
      credentials: createCredentialStore(join(ctx.layout.root, 'auth')),
      ...(selector === undefined ? {} : { selector }),
      signal: ctx.signal,
    })
    if (r.kind === 'online') {
      const note = r.refreshed ? '（令牌已刷新）' : ''
      process.stderr.write(`${C.dim}· 账号 ${r.account.name}${note}${C.reset}\n`)
      return { ok: true, account: r.account }
    }
    process.stderr.write(`${C.dim}· 离线模式：${r.reason}${C.reset}\n`)
    return { ok: true }
  } catch (err) {
    if (!isAuthError(err)) throw err
    process.stderr.write(`${C.red}${err.code}${C.reset}: ${err.message}\n`)
    if (err.hint !== undefined) process.stderr.write(`${C.dim}${err.hint}${C.reset}\n`)
    return { ok: false }
  }
}
