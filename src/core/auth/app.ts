/**
 * BlockPilot 自己的 Azure 应用注册。
 *
 * 为什么可以硬编码：设备码属于**公共客户端**，没有 client secret——
 * 这个 id 天生就是公开的，泄露它拿不到任何东西，任何人注册应用时它都印在门户页面上。
 * 不能硬编码的是**别人的** id（官方启动器、PCL、HMCL 的），那是冒充。
 *
 * 有了它，「下载即用」才成立：以前跑 login 要先自己去 portal.azure.com 注册一个应用，
 * 对只想进服务器的玩家来说是一道没有意义的手续（ADR-0039 推翻了 ADR-0024 的第 2 条）。
 *
 * 注册参数（与 ADR-0024 的表一致，除账户类型外）：
 *   账户类型        所有 Microsoft 帐户用户
 *   公共客户端流    开启（关掉的话 devicecode 直接 AADSTS7000218）
 *   委托权限        XboxLive.signin
 *
 * 租户仍固定用 `consumers`（见 msa.ts）：Minecraft 只认个人微软账号，
 * 组织账号走到 XSTS 必然失败，早点把范围限死能给出更准确的报错。
 */
export const DEFAULT_CLIENT_ID = 'd2f40521-2892-4555-bb2d-11cd748dedf6'

export interface ClientIdSources {
  /** 命令行 `--client-id` */
  readonly flag?: string | undefined
  /** 环境变量 `BLOCKPILOT_CLIENT_ID` */
  readonly env?: string | undefined
}

/**
 * 决定这次用哪个应用 id。
 *
 * 优先级：显式参数 > 环境变量 > 内置默认。
 * 空串按「没给」处理——Windows 的 `--client-id ""` 会真的传进来一个空串，
 * 把它当成合法值会让用户拿到一条指向空 id 的 AADSTS 错误，而不是默认值。
 */
export function resolveClientId(sources: ClientIdSources = {}): string {
  const flag = sources.flag?.trim()
  if (flag !== undefined && flag !== '') return flag
  const env = sources.env?.trim()
  if (env !== undefined && env !== '') return env
  return DEFAULT_CLIENT_ID
}
