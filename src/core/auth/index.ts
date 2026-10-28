import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { exchangeMsaForAccount, isExpired, refreshAccount } from './chain.js'
import type { HttpClient } from './http.js'
import { pollForToken, requestDeviceCode, type SleepFn } from './msa.js'
import { loadStore, pickAccount, upsertAccount } from './store.js'
import { authError, isAuthError, type AuthAccount } from './types.js'
import type { DeviceCode } from './types.js'

export interface LoginOptions {
  readonly clientId: string
  /** `<root>/auth/accounts.json` */
  readonly storePath: string
  readonly http?: HttpClient
  readonly sleepFn?: SleepFn
  readonly now?: () => number
}

/**
 * 设备码登录。
 *
 * 编排留在这里而不是塞进 chain.ts：设备码必须**先成为事件**再开始轮询，
 * 否则用户面对的是一片沉默的终端，15 分钟后报「已过期」。
 * 事件边界就是可观察性的边界。
 */
export function createLogin(opts: LoginOptions): Operation<AuthAccount> {
  return defineOperation<AuthAccount>('login', async function* (signal) {
    const now = opts.now ?? ((): number => Date.now())
    const shared = {
      ...(opts.http === undefined ? {} : { http: opts.http }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
    }

    try {
      if (opts.clientId === '') {
        throw authError(
          'AUTH_NO_CLIENT_ID',
          '没有配置 Azure 应用 id',
          '在 portal.azure.com 注册一个应用（允许公共客户端流），然后传 --client-id 或设 BLOCKPILOT_CLIENT_ID',
        )
      }

      yield Op.log('info', 'auth.step', { step: 'device_code' })
      const code = await requestDeviceCode({ clientId: opts.clientId, ...shared, signal })
      // 这条事件是给**人**看的，不是给程序的分支条件
      yield Op.log('info', 'auth.device_code', {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresInSec: Math.max(0, Math.round((code.expiresAt - now()) / 1000)),
        intervalMs: code.intervalMs,
      })

      yield Op.log('info', 'auth.step', { step: 'waiting' })
      const msa = await pollForToken({
        clientId: opts.clientId,
        code,
        ...shared,
        ...(opts.sleepFn === undefined ? {} : { sleepFn: opts.sleepFn }),
        signal,
      })

      yield Op.log('info', 'auth.step', { step: 'xbox' })
      const account = await exchangeMsaForAccount(msa, { ...shared, signal })
      const full: AuthAccount = { ...account, clientId: opts.clientId, userType: 'msa' }

      upsertAccount(opts.storePath, full)
      yield Op.result(full)
      yield Op.done()
    } catch (err) {
      yield* asFailed(err)
    }
  })
}

export interface ResolveAccountOptions {
  readonly storePath: string
  /** 用户显式指定的名字或 uuid。给了就必须能用，不能静默降级 */
  readonly selector?: string
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export type ResolveResult =
  | { readonly kind: 'online'; readonly account: AuthAccount; readonly refreshed: boolean }
  /** 没有可用账号，调用方退回离线模式 */
  | { readonly kind: 'offline'; readonly reason: string }

/**
 * 为启动挑选账号，过期就自动刷新。
 *
 * 两种失败的处理刻意不同：
 *   - 默认账号刷不动 → 退回离线并说明原因。玩家多半只想玩单人，
 *     拦在门口没有意义
 *   - 用户点名要某个账号 → 大声失败。他明确要求了在线身份，
 *     悄悄用离线身份进游戏，朋友会看到「这不是你」
 */
export async function resolveAccount(opts: ResolveAccountOptions): Promise<ResolveResult> {
  const store = loadStore(opts.storePath)
  const account = pickAccount(store, opts.selector)
  const explicit = opts.selector !== undefined && opts.selector.trim() !== ''

  if (account === null) {
    if (explicit) {
      throw authError(
        'AUTH_ACCOUNT_NOT_FOUND',
        `找不到账号：${opts.selector ?? ''}`,
        '用 `blockpilot accounts` 看已保存的账号，或先 `blockpilot login`',
      )
    }
    return { kind: 'offline', reason: '还没有登录过微软账号' }
  }

  const now = opts.now ?? ((): number => Date.now())
  if (!isExpired(account, now())) {
    return { kind: 'online', account, refreshed: false }
  }

  try {
    const fresh = await refreshAccount(account, {
      ...(opts.http === undefined ? {} : { http: opts.http }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    })
    upsertAccount(opts.storePath, fresh)
    return { kind: 'online', account: fresh, refreshed: true }
  } catch (err) {
    if (explicit) throw err
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'offline', reason: `账号 ${account.name} 的令牌刷新失败：${message}` }
  }
}

/** 把异常转成 failed 事件。非 AuthError 也要带上可执行建议。 */
async function* asFailed(err: unknown): AsyncGenerator<ReturnType<typeof Op.failed>> {
  if (isAuthError(err)) {
    yield Op.failed(err.code, err.message, err.hint)
    return
  }
  const message = err instanceof Error ? err.message : String(err)
  yield Op.failed(
    'AUTH_UNEXPECTED',
    `登录过程中出现未预期的错误：${message}`,
    '重试；持续失败请带上这条消息反馈',
  )
}

export type { DeviceCode }
export { loadStore, pickAccount, removeAccount, authStorePath, upsertAccount } from './store.js'
export { isExpired } from './chain.js'
export { AuthError, isAuthError } from './types.js'
export type { AuthAccount, AuthErrorCode } from './types.js'
