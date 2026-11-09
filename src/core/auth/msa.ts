import { createHttp, type HttpClient, num, str } from './http.js'
import { authError, type DeviceCode, type MsaToken } from './types.js'

/**
 * 微软账号（MSA）的设备码登录。
 *
 * 选设备码而不是内嵌浏览器/本地回调服务器：
 * 参考实现不该让用户在一段无法审查的代码里输微软密码。设备码把密码留在
 * 微软自己的页面上，我们只拿一个短时效的 user code。
 *
 * 端点用 `consumers` 租户：Minecraft 只认个人微软账号，组织账号连上去
 * 会在 XSTS 那一步失败，早点限定范围能给出更准确的报错。
 */
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'

/**
 * 请求的 scope。
 *
 * `offline_access` 不是可选项——没有它就拿不到 refresh_token，
 * 用户每次启动都要重新走一遍设备码，那不是一个能用的启动器。
 * `XboxLive.signin` 是换 Xbox 令牌的前提。
 */
const SCOPE = 'XboxLive.signin offline_access'

/** 设备码默认存活 15 分钟；轮询期间要贴着服务端给的 interval 走。 */
const DEFAULT_INTERVAL_MS = 5_000

/**
 * 设备码输入页的备用地址。
 *
 * 微软返回的 `verification_uri` 恒为 `https://www.microsoft.com/link`，它 301 到
 * `login.live.com`——那个域名在国内经常连不上，用户看到的是一张打不开的白页，
 * 而设备码只有 15 分钟。这里直接给跳转的终点，省掉一次跨域。
 *
 * 别换成 `login.microsoftonline.com/common/oauth2/deviceauth`（`microsoft.com/devicelogin`
 * 的落地页）：那是**工作/学校账户**的 AAD 表单，页面标题是 “Sign in to your account”，
 * 输消费者设备码会被判成「该代码无法工作」。消费者账户的入口是标题为
 * “Microsoft account” 的 `login.live.com`，也就是本常量。实测踩过两次。
 */
export const DEVICE_AUTH_FALLBACK_URI = 'https://login.live.com/oauth20_remoteconnect.srf'

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export const sleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(authError('AUTH_ABORTED', '登录已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(authError('AUTH_ABORTED', '登录已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface DeviceCodeOptions {
  readonly clientId: string
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/**
 * 申请一个设备码。返回值里 **deviceCode 不能给用户看**——它是能直接换令牌的凭据。
 */
export async function requestDeviceCode(opts: DeviceCodeOptions): Promise<DeviceCode> {
  if (opts.clientId === '') {
    throw authError(
      'AUTH_NO_CLIENT_ID',
      '没有配置 Azure 应用 id',
      '在 portal.azure.com 注册一个应用（允许公共客户端流），然后传 --client-id',
    )
  }

  const http = opts.http ?? createHttp()
  const now = opts.now ?? ((): number => Date.now())
  const res = await http.postForm(
    `${AUTHORITY}/devicecode`,
    { client_id: opts.clientId, scope: SCOPE },
    opts.signal,
  )

  if (res.status !== 200) {
    const desc =
      str(res.body, 'error_description') ?? str(res.body, 'error') ?? `HTTP ${res.status}`
    throw authError(
      'AUTH_DEVICE_CODE_FAILED',
      `申请设备码失败：${desc}`,
      '检查 --client-id 是否是有效的 Azure 应用（个人账号租户），且已开启「允许公共客户端流」',
    )
  }

  const deviceCode = str(res.body, 'device_code')
  const userCode = str(res.body, 'user_code')
  const verificationUri = str(res.body, 'verification_uri')
  const expiresIn = num(res.body, 'expires_in')
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
    throw authError(
      'AUTH_DEVICE_CODE_FAILED',
      '设备码响应缺少必要字段（device_code/user_code/verification_uri）',
    )
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    expiresAt: now() + (expiresIn ?? 900) * 1000,
    intervalMs: (num(res.body, 'interval') ?? 5) * 1000 || DEFAULT_INTERVAL_MS,
  }
}

export interface PollOptions {
  readonly clientId: string
  readonly code: DeviceCode
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
  readonly sleepFn?: SleepFn
}

/**
 * 轮询直到用户完成授权。
 *
 * 三类「不是失败」的响应必须区别对待，混在一起会让用户在最不该等的时候被踢出去：
 *   authorization_pending  继续等
 *   slow_down              服务端嫌太快，间隔 +5s 后继续（RFC 8628 的要求）
 *   expired_token          设备码过期，只能重新申请
 */
export async function pollForToken(opts: PollOptions): Promise<MsaToken> {
  const http = opts.http ?? createHttp()
  const now = opts.now ?? ((): number => Date.now())
  const wait = opts.sleepFn ?? sleep
  let interval = opts.code.intervalMs

  for (;;) {
    if (opts.signal?.aborted === true) throw authError('AUTH_ABORTED', '登录已取消')
    if (now() >= opts.code.expiresAt) {
      throw authError(
        'AUTH_EXPIRED',
        '设备码已过期，用户没有在时限内完成授权',
        '重新运行一次 login，会拿到新的代码',
      )
    }

    const res = await http.postForm(
      `${AUTHORITY}/token`,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: opts.clientId,
        device_code: opts.code.deviceCode,
      },
      opts.signal,
    )

    if (res.status === 200) {
      const accessToken = str(res.body, 'access_token')
      const refreshToken = str(res.body, 'refresh_token')
      const expiresIn = num(res.body, 'expires_in')
      if (accessToken === undefined || refreshToken === undefined) {
        throw authError('AUTH_DEVICE_CODE_FAILED', '令牌响应缺少 access_token 或 refresh_token')
      }
      return {
        accessToken,
        refreshToken,
        expiresAt: now() + (expiresIn ?? 3600) * 1000,
      }
    }

    const error = str(res.body, 'error') ?? ''
    if (error === 'authorization_pending') {
      await wait(interval, opts.signal)
      continue
    }
    if (error === 'slow_down') {
      interval += 5_000
      await wait(interval, opts.signal)
      continue
    }
    if (error === 'expired_token') {
      throw authError('AUTH_EXPIRED', '设备码已过期', '重新运行一次 login')
    }
    if (error === 'authorization_declined' || error === 'access_denied') {
      throw authError('AUTH_DENIED', '用户在授权页面上拒绝了本次登录')
    }

    const desc = str(res.body, 'error_description') ?? error ?? `HTTP ${res.status}`
    throw authError('AUTH_DEVICE_CODE_FAILED', `换取令牌失败：${desc}`)
  }
}

export interface RefreshOptions {
  readonly clientId: string
  readonly refreshToken: string
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/**
 * 用 refresh_token 换新的 MSA 令牌。
 *
 * **返回值里的 refreshToken 必须写回存档**：微软的刷新令牌是一次性的，
 * 每次使用都会签发一个新的，旧的在几分钟后失效。沿用旧的会导致下次刷新失败，
 * 用户看到的是「昨天还好好的，今天又要重新登录」。
 */
export async function refreshMsaToken(opts: RefreshOptions): Promise<MsaToken> {
  const http = opts.http ?? createHttp()
  const now = opts.now ?? ((): number => Date.now())
  const res = await http.postForm(
    `${AUTHORITY}/token`,
    {
      grant_type: 'refresh_token',
      client_id: opts.clientId,
      refresh_token: opts.refreshToken,
      scope: SCOPE,
    },
    opts.signal,
  )

  if (res.status !== 200) {
    const error = str(res.body, 'error') ?? ''
    if (error === 'invalid_grant') {
      throw authError(
        'AUTH_REFRESH_UNAVAILABLE',
        '刷新令牌已失效（可能被撤销、改密码或超过 90 天未使用）',
        '重新运行 login 走一次设备码授权',
      )
    }
    const desc = str(res.body, 'error_description') ?? `HTTP ${res.status}`
    throw authError('AUTH_REFRESH_UNAVAILABLE', `刷新令牌失败：${desc}`, '重新运行 login')
  }

  const accessToken = str(res.body, 'access_token')
  const refreshToken = str(res.body, 'refresh_token') ?? opts.refreshToken
  if (accessToken === undefined) {
    throw authError('AUTH_REFRESH_UNAVAILABLE', '刷新响应缺少 access_token')
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: now() + (num(res.body, 'expires_in') ?? 3600) * 1000,
  }
}
