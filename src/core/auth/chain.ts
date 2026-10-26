import { authError, type AuthAccount, type DeviceCode, type MsaToken } from './types.js'
import type { HttpClient } from './http.js'
import { pollForToken, refreshMsaToken, requestDeviceCode, sleep, type SleepFn } from './msa.js'
import {
  assertGameOwnership,
  authenticateXbl,
  authorizeXsts,
  fetchProfile,
  loginWithXbox,
} from './xbox.js'

/**
 * 把「MSA 令牌」走完整条链换成可启动的账号。
 *
 * 抽出来是因为登录与刷新共用它：两者都从 MSA 令牌开始，
 * 后续三跳完全一致。写两份的话，改一个端点要记得改两处。
 */
export interface ExchangeOptions {
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export async function exchangeMsaForAccount(
  msa: MsaToken,
  opts: ExchangeOptions = {},
): Promise<Omit<AuthAccount, 'clientId' | 'userType'>> {
  const xbl = await authenticateXbl(msa.accessToken, opts)
  const xsts = await authorizeXsts(xbl.token, opts)
  const mc = await loginWithXbox(xsts, opts)

  // 顺序有讲究：先确认「买了」，再确认「有档案」。
  // 只买了基岩版的人也有 Xbox 档案，但没有 Java 档案——
  // 先查档案会把这类用户报成「没有档案」，其实是「没买 Java 版」。
  await assertGameOwnership(mc.accessToken, opts)
  const profile = await fetchProfile(mc.accessToken, opts)

  return {
    uuid: profile.id,
    name: profile.name,
    accessToken: mc.accessToken,
    expiresAt: mc.expiresAt,
    ...(xsts.xuid === undefined ? {} : { xuid: xsts.xuid }),
    refreshToken: msa.refreshToken,
    obtainedAt: (opts.now ?? Date.now)(),
  }
}

export interface LoginOptions extends ExchangeOptions {
  readonly clientId: string
  /** 拿到设备码后立刻回调——用户要凭它去浏览器里输 */
  readonly onDeviceCode?: (code: DeviceCode) => void
  readonly sleepFn?: SleepFn
}

/**
 * 完整登录：设备码 → 轮询 → 三跳 → 账号。
 *
 * 不写文件、不打印。落盘与渲染是调用方的事（Operation + Consumer）。
 */
export async function loginWithMicrosoft(opts: LoginOptions): Promise<AuthAccount> {
  const code = await requestDeviceCode({
    clientId: opts.clientId,
    ...(opts.http === undefined ? {} : { http: opts.http }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  opts.onDeviceCode?.(code)

  const msa = await pollForToken({
    clientId: opts.clientId,
    code,
    ...(opts.http === undefined ? {} : { http: opts.http }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.sleepFn === undefined ? {} : { sleepFn: opts.sleepFn }),
  })

  const account = await exchangeMsaForAccount(msa, opts)
  return { ...account, clientId: opts.clientId, userType: 'msa' }
}

export interface RefreshAccountOptions extends ExchangeOptions {}

/**
 * 用存档里的 refresh_token 换一个新账号对象。
 *
 * 取舍：刷新走的是**完整三跳**，而不是只换 MC 令牌。原因是 MC 令牌一旦过期，
 * 就不能用它去续 XSTS；而 XSTS 又是每次启动必换的。既然横竖要重走链，
 * 就不额外维护「XSTS 还在有效期内」的状态——多一个状态就多一个过期判断写错的地方。
 */
export async function refreshAccount(
  account: AuthAccount,
  opts: RefreshAccountOptions = {},
): Promise<AuthAccount> {
  if (account.refreshToken === undefined || account.clientId === undefined) {
    throw authError(
      'AUTH_REFRESH_UNAVAILABLE',
      '这个账号没有保存刷新令牌（可能是在旧版本里登录的）',
      '重新运行一次 login',
    )
  }

  const msa = await refreshMsaToken({
    clientId: account.clientId,
    refreshToken: account.refreshToken,
    ...(opts.http === undefined ? {} : { http: opts.http }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })

  const fresh = await exchangeMsaForAccount(msa, opts)
  return { ...fresh, clientId: account.clientId, userType: 'msa' }
}

/**
 * 令牌是否已经不能用了。
 *
 * 留 60 秒余量：正好在到期瞬间拿去启动，走到游戏里就过期了，
 * 表现为「连上了但进不去服务器」。提前一分钟刷新，代价是一次请求。
 */
export function isExpired(account: AuthAccount, now: number = Date.now(), skewMs = 60_000): boolean {
  return account.expiresAt - skewMs <= now
}

/** 登录默认用的等待函数，测试里注入假的。 */
export const defaultSleep: SleepFn = sleep
