/**
 * 账号相关用例：解析登录身份、判断离线用户名是否合法。
 *
 * 身份解析组合 auth core；这里不写输出，notice / failure 交给命令层渲染。
 */
import { join } from 'node:path'
import { createCredentialStore } from '../../core/auth/credentials.js'
import {
  authStorePath,
  createLogin,
  isAuthError,
  loadStore,
  removeAccount,
  resolveAccount,
  resolveClientId,
} from '../../core/auth/index.js'
import type { AuthAccount } from '../../core/auth/types.js'
import type { CommandContext } from '../command/context.js'

export type AuthNotice =
  | { readonly kind: 'online'; readonly name: string; readonly refreshed: boolean }
  | { readonly kind: 'offline'; readonly reason: string }

export type AuthResolution =
  | { readonly ok: true; readonly account?: AuthAccount; readonly notice?: AuthNotice }
  | { readonly ok: false; readonly code?: string; readonly message: string; readonly hint?: string }

/**
 * 离线用户名的合法性（不阻断）。
 *
 * MC 的离线名只认字母、数字、下划线，长度 1–16。中文名单机能进，但联机时
 * 服务端会拒绝或显示乱码——这是新手最常踩的坑之一，网上的教程都会特意提醒。
 * 单人确实能玩，所以只提醒，不拦。
 */
export function offlineNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

/** 设备码登录的备用地址；命令渲染用，仍由 core 定义。 */
export { DEVICE_AUTH_FALLBACK_URI } from '../../core/auth/index.js'

/** 设备码登录的 client id：flag 优先，其次环境变量，最后由 core 兜底。 */
export function loginClientId(ctx: CommandContext): string {
  return resolveClientId({
    flag: ctx.value('--client-id'),
    env: process.env.BLOCKPILOT_CLIENT_ID,
  })
}

/** 登录 Operation 的装配；命令只负责渲染事件。 */
export function createLoginOperation(
  ctx: CommandContext,
  opts: { readonly clientId: string; readonly timeoutMs?: number },
): ReturnType<typeof createLogin> {
  return createLogin({
    clientId: opts.clientId,
    storePath: authStorePath(ctx.layout.root),
    credentials: createCredentialStore(join(ctx.layout.root, 'auth')),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  })
}

/** 已保存账号列表；命令只渲染，不认识 store 的读写细节。 */
export function savedAccounts(ctx: CommandContext): {
  readonly storePath: string
  readonly accounts: readonly AuthAccount[]
  readonly active?: string
} {
  const storePath = authStorePath(ctx.layout.root)
  const store = loadStore(storePath, createCredentialStore(join(ctx.layout.root, 'auth')))
  return {
    storePath,
    accounts: store.accounts,
    ...(store.active === undefined ? {} : { active: store.active }),
  }
}

/** 删除一个账号；返回是否真的删到了。 */
export function removeSavedAccount(ctx: CommandContext, selector: string): boolean {
  return removeAccount(
    authStorePath(ctx.layout.root),
    selector,
    createCredentialStore(join(ctx.layout.root, 'auth')),
  )
}

/**
 * 为启动挑账号。
 *
 * 三种情况分开处理，因为「用户此刻想要什么」不同：
 *   --offline     明确要离线，不问存档
 *   有存档        用它（过期就自动刷新）
 *   没存档        离线，并返回 notice 让命令层说明一句
 *
 * 点名要 `--account` 却拿不到时返回 ok:false：他要的是在线身份，
 * 悄悄用离线身份进去，朋友会看到「这不是你」。
 */
export async function resolveAuth(ctx: CommandContext): Promise<AuthResolution> {
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
      return {
        ok: true,
        account: r.account,
        notice: { kind: 'online', name: r.account.name, refreshed: r.refreshed },
      }
    }
    return { ok: true, notice: { kind: 'offline', reason: r.reason } }
  } catch (err) {
    if (!isAuthError(err)) throw err
    return {
      ok: false,
      code: err.code,
      message: err.message,
      ...(err.hint === undefined ? {} : { hint: err.hint }),
    }
  }
}
