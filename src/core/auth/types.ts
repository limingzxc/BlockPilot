import { BlockPilotError } from '../errors.js'

/**
 * 认证相关的数据形状。
 *
 * 分三层是因为它们的寿命完全不同：
 *   MSA token   1 小时，且每次刷新都会换一个新的 refresh_token
 *   XSTS token  约 1 小时，且绑定了 RelyingParty（这里是 Minecraft 的 API）
 *   MC token    24 小时，但只能通过「MSA → XBL → XSTS → MC」这条链换出来
 *
 * 所以存档里只留 refresh_token + 最后一次换到的 MC token：
 * 过期的 MC token 可以用 refresh_token 重新走一遍链，不需要用户再点一次授权。
 */

/** 认证失败的错误码。给人看的是 message，给程序分支用的是 code。 */
export type AuthErrorCode =
  | 'AUTH_NO_CLIENT_ID'
  | 'AUTH_DEVICE_CODE_FAILED'
  | 'AUTH_DENIED'
  | 'AUTH_EXPIRED'
  | 'AUTH_TIMEOUT'
  | 'AUTH_ABORTED'
  | 'AUTH_NETWORK'
  | 'XBL_FAILED'
  | 'XSTS_NO_XBOX_ACCOUNT'
  | 'XSTS_REGION_BLOCKED'
  | 'XSTS_ADULT_VERIFICATION'
  | 'XSTS_CHILD_ACCOUNT'
  | 'XSTS_FAILED'
  | 'MC_LOGIN_FAILED'
  | 'MC_APP_NOT_ALLOWLISTED'
  | 'MC_NO_GAME_OWNERSHIP'
  | 'MC_NO_PROFILE'
  | 'MC_PROFILE_FAILED'
  | 'AUTH_REFRESH_UNAVAILABLE'
  | 'AUTH_STORE_CORRUPT'
  | 'AUTH_ACCOUNT_NOT_FOUND'

/**
 * 认证错误。
 *
 * hint 必须是**可执行的下一步**，不是对现象的重述——「你买了吗」不是建议，
 * 「换一个有 Minecraft 的微软账号，或去 minecraft.net 购买」才是。
 */
export class AuthError extends BlockPilotError {
  // declare：不要生成实例字段，否则 ES2022 的字段初始化会把 super 里赋的值冲掉
  declare readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string, hint?: string) {
    super(code, message, hint === undefined ? {} : { hint })
    this.name = 'AuthError'
  }
}

export function authError(code: AuthErrorCode, message: string, hint?: string): AuthError {
  return new AuthError(code, message, hint)
}

export function isAuthError(err: unknown): err is AuthError {
  return err instanceof AuthError
}

/** 一次 OAuth 令牌交换的结果。 */
export interface MsaToken {
  readonly accessToken: string
  readonly refreshToken: string
  /** epoch 毫秒 */
  readonly expiresAt: number
}

/**
 * 设备码登录的一次性会话。
 *
 * 用户看到的是 userCode（如 `AB12CD34`）和 verificationUri（aka.ms/link），
 * 程序拿 deviceCode 去轮询。两者不能混用——把 deviceCode 显示给用户，
 * 等于把一个可以直接换令牌的凭据印在屏幕上。
 */
export interface DeviceCode {
  readonly deviceCode: string
  readonly userCode: string
  readonly verificationUri: string
  /** epoch 毫秒 */
  readonly expiresAt: number
  /** 服务端建议的轮询间隔 */
  readonly intervalMs: number
}

/** Xbox Live 与 XSTS 是同一套形状：一个 JWT + 一个 user hash。 */
export interface XboxToken {
  readonly token: string
  readonly userHash: string
  /**
   * XSTS 的 `xui[0].xid`，也就是游戏的 `--xuid`。
   *
   * 不是每个账号的响应都带它，所以是可选的：拿不到就不传，
   * 游戏仍能进单人，只是社交/成就相关功能降级。
   */
  readonly xuid?: string
}

/** 用 XSTS 换到的 Minecraft 访问令牌。 */
export interface MinecraftToken {
  readonly accessToken: string
  /** epoch 毫秒 */
  readonly expiresAt: number
}

/** Minecraft 账号档案（来自 /minecraft/profile）。 */
export interface MinecraftProfile {
  /** 32 位十六进制，**不带**连字符 */
  readonly id: string
  readonly name: string
}

/**
 * 存档里的一个账号。
 *
 * 字段是「够用来启动 + 够用来刷新」的最小集合：
 * 启动要 name/uuid/accessToken/xuid，刷新要 refreshToken + clientId（必须与登录时一致）。
 */
export interface AuthAccount {
  /** 32 位十六进制，不带连字符。游戏的 --uuid 就要这个形状 */
  readonly uuid: string
  readonly name: string
  readonly accessToken: string
  /** MC token 的过期时刻，epoch 毫秒 */
  readonly expiresAt: number
  /** 1.18+ 的 --xuid。拿不到就不传，游戏仍能离线进单人 */
  readonly xuid?: string | undefined
  readonly refreshToken?: string | undefined
  /** 换出这个账号时用的 Azure 应用 id。刷新必须用同一个 */
  readonly clientId?: string | undefined
  /** 登录时刻，供 `accounts` 展示 */
  readonly obtainedAt: number
  /** 在线账号恒为 msa；离线模式的占位账号不会进存档 */
  readonly userType: 'msa'
}
