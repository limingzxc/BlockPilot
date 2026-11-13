import { errMessage } from '../errors.js'
import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import { exchangeMsaForAccount, isExpired, refreshAccount } from './chain.js'
import type { CredentialStore } from './credentials.js'
import type { HttpClient } from './http.js'
import { pollForToken, requestDeviceCode, type SleepFn } from './msa.js'
import { loadStore, pickAccount, upsertAccount } from './store.js'
import type { DeviceCode } from './types.js'
import { type AuthAccount, authError, isAuthError, type MsaToken } from './types.js'

export interface LoginOptions {
  readonly clientId: string
  /** `<root>/auth/accounts.json` */
  readonly storePath: string
  readonly http?: HttpClient
  readonly sleepFn?: SleepFn
  readonly now?: () => number
  /**
   * 本地等待上限（毫秒）。到点即失败，不等设备码自己过期。
   *
   * 给「有人在等结果」的场合用（代理执行、脚本）：设备码活 15 分钟，
   * 没人输码时让进程干等满 15 分钟，是最贵的空转。
   */
  readonly timeoutMs?: number
  /** 系统凭据存储。给了就把 refresh_token 从文件里挪走 */
  readonly credentials?: CredentialStore | null
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
    let timedOut = false

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
        /** 绝对时刻：调用方要能直接说「有效至 12:57」，而不是让人心算 15 分钟 */
        expiresAt: code.expiresAt,
        expiresInSec: Math.max(0, Math.round((code.expiresAt - now()) / 1000)),
        intervalMs: code.intervalMs,
      })

      yield Op.log('info', 'auth.step', { step: 'waiting' })
      const msa = await waitForToken(opts, code, signal, () => {
        timedOut = true
      })

      yield Op.log('info', 'auth.step', { step: 'xbox' })
      const account = await exchangeMsaForAccount(msa, { ...shared, signal })
      const full: AuthAccount = { ...account, clientId: opts.clientId, userType: 'msa' }

      upsertAccount(opts.storePath, full, opts.credentials ?? null)
      yield Op.result(full)
      yield Op.done()
    } catch (err) {
      // 超时与「服务端说设备码过期」是两回事：前者换码就能重试，后者要重新申请
      if (timedOut) {
        const ms = opts.timeoutMs ?? 0
        // 亚秒级只在测试里出现，但把 40ms 四舍五入成「0 秒」会让人以为没设超时
        const shown = ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${ms} 毫秒`
        yield Op.failed(
          'AUTH_TIMEOUT',
          `等待授权超时（${shown}内没有完成）`,
          '设备码本身仍然有效；重新运行 login 会拿到新码，去掉 --timeout 可以等满 15 分钟',
        )
        return
      }
      yield* asFailed(err)
    }
  })
}

/**
 * 轮询等待授权，可选地套一层本地超时。
 *
 * 超时用 AbortSignal 表达而不是 `Promise.race`：`pollForToken` 的睡眠与请求都认 signal，
 * race 只能让外层先返回，底下的定时器和在途请求还会继续跑。被超时打断时通过
 * `onTimeout` 告诉调用方「这次是本地放弃，不是服务端说码过期」——两者的补救动作不同。
 */
async function waitForToken(
  opts: LoginOptions,
  code: DeviceCode,
  signal: AbortSignal,
  onTimeout: () => void,
): Promise<MsaToken> {
  const budget = opts.timeoutMs === undefined ? undefined : new AbortController()
  const timer =
    budget === undefined
      ? undefined
      : setTimeout(() => {
          onTimeout()
          budget.abort()
        }, opts.timeoutMs)

  try {
    return await pollForToken({
      clientId: opts.clientId,
      code,
      ...(opts.http === undefined ? {} : { http: opts.http }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.sleepFn === undefined ? {} : { sleepFn: opts.sleepFn }),
      signal: budget === undefined ? signal : AbortSignal.any([signal, budget.signal]),
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface ResolveAccountOptions {
  readonly storePath: string
  /** 用户显式指定的名字或 uuid。给了就必须能用，不能静默降级 */
  readonly selector?: string
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly credentials?: CredentialStore | null
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
  const store = loadStore(opts.storePath, opts.credentials ?? null)
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
    upsertAccount(opts.storePath, fresh, opts.credentials ?? null)
    return { kind: 'online', account: fresh, refreshed: true }
  } catch (err) {
    if (explicit) throw err
    const message = errMessage(err)
    return { kind: 'offline', reason: `账号 ${account.name} 的令牌刷新失败：${message}` }
  }
}

/** 把异常转成 failed 事件。非 AuthError 也要带上可执行建议。 */
async function* asFailed(err: unknown): AsyncGenerator<ReturnType<typeof Op.failed>> {
  if (isAuthError(err)) {
    yield Op.failed(err.code, err.message, err.hint)
    return
  }
  const message = errMessage(err)
  yield Op.failed(
    'AUTH_UNEXPECTED',
    `登录过程中出现未预期的错误：${message}`,
    '重试；持续失败请带上这条消息反馈',
  )
}

export { DEFAULT_CLIENT_ID, resolveClientId } from './app.js'
export { isExpired } from './chain.js'
export { DEVICE_AUTH_FALLBACK_URI } from './msa.js'
export { authStorePath, loadStore, pickAccount, removeAccount, upsertAccount } from './store.js'
export type { AuthAccount, AuthErrorCode } from './types.js'
export { AuthError, isAuthError } from './types.js'
export type { DeviceCode }
