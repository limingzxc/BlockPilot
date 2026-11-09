import { createHttp, type HttpClient, num, str } from './http.js'
import { authError, type MinecraftProfile, type MinecraftToken, type XboxToken } from './types.js'

/**
 * Xbox Live → XSTS → Minecraft 这条链。
 *
 * 为什么必须三步：微软账号只是身份，Xbox Live 是授权域，Minecraft 是资源。
 * 每一步换出的令牌只对下一步有效，跳不过去也复不了用。
 *
 * 五个端点都是固定域名，没有镜像。它们在国内通常可达（Mojang 和微软的
 * 登录基础设施和 maven 不是一回事），所以这里不引入源抽象——真出问题时
 * 代理是唯一解，而代理已经在 core/proxy.ts 里统一处理。
 */
const XBL_AUTH = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_AUTH = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile'
const MC_ENTITLEMENTS = 'https://api.minecraftservices.com/entitlements/mcstore'

/** Minecraft API 只接受这个 RelyingParty，写错会被 XSTS 以 400 拒绝。 */
const MC_RELYING_PARTY = 'rp://api.minecraftservices.com/'

export interface XboxOptions {
  readonly http?: HttpClient
  readonly signal?: AbortSignal
  readonly now?: () => number
}

/** MSA 的 access token → Xbox Live 令牌。 */
export async function authenticateXbl(
  msaAccessToken: string,
  opts: XboxOptions = {},
): Promise<XboxToken> {
  const http = opts.http ?? createHttp()
  const res = await http.postJson(
    XBL_AUTH,
    {
      Properties: {
        /**
         * 少了这一项，Xbox 服务返回 **400 且响应体为空**——看起来像令牌失效，
         * 实际是请求不合法。实测：同一份垃圾令牌，没有 AuthMethod 是 400，
         * 加上就变成语义正确的 401。这个坑排查了很久，别再删。
         */
        AuthMethod: 'RPS',
        // `d=` 前缀表示这是直接给 Xbox Live 的令牌，不是 Compact 票据
        RpsTicket: `d=${msaAccessToken}`,
        SiteName: 'user.auth.xboxlive.com',
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    opts.signal,
  )

  if (res.status !== 200) {
    const desc = str(res.body, 'Message')
    const tail = desc === undefined ? '' : `（${desc}）`
    if (res.status === 401) {
      throw authError(
        'XBL_FAILED',
        `Xbox Live 拒绝了令牌（401）${tail}`,
        'MSA 令牌可能已过期或已被撤销，重新 login',
      )
    }
    throw authError(
      'XBL_FAILED',
      `Xbox Live 授权失败：${desc ?? `HTTP ${res.status}`}${tail}`,
      '400 且响应体为空通常意味着请求形状不对（AuthMethod / RpsTicket 前缀），不是账号问题',
    )
  }

  const parsed = parseXboxToken(res.body)
  if (parsed === null) {
    throw authError('XBL_FAILED', 'Xbox Live 响应里没有令牌或 user hash')
  }
  return parsed
}

/** XBL 令牌 → XSTS 令牌。失败时把 XErr 翻译成用户能照做的建议。 */
export async function authorizeXsts(xblToken: string, opts: XboxOptions = {}): Promise<XboxToken> {
  const http = opts.http ?? createHttp()
  const res = await http.postJson(
    XSTS_AUTH,
    {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: MC_RELYING_PARTY,
      TokenType: 'JWT',
    },
    opts.signal,
  )

  if (res.status !== 200) {
    const xerr = num(res.body, 'XErr')
    if (xerr !== undefined) throw mapXstsError(xerr, str(res.body, 'Message'))
    const desc = str(res.body, 'Message') ?? `HTTP ${res.status}`
    throw authError('XSTS_FAILED', `XSTS 授权失败：${desc}`)
  }

  const parsed = parseXboxToken(res.body)
  if (parsed === null) {
    throw authError('XSTS_FAILED', 'XSTS 响应里没有令牌或 user hash')
  }
  return parsed
}

/**
 * XSTS 的错误码比 HTTP 状态码有用得多。
 *
 * 这些都是「用户必须去做点别的」的情况，笼统报一句「认证失败」等于没说：
 * 未成年人要去加家庭组，没档案要去 xbox.com，买没买游戏是另一回事。
 */
function mapXstsError(xerr: number, message: string | undefined): Error {
  const tail = message === undefined ? '' : `（${message}）`
  switch (xerr) {
    case 2148916233:
      return authError(
        'XSTS_NO_XBOX_ACCOUNT',
        `这个微软账号还没有 Xbox 档案${tail}`,
        '去 xbox.com 用同一个账号登录一次，会自动创建档案（免费），然后重试',
      )
    case 2148916235:
      return authError(
        'XSTS_REGION_BLOCKED',
        `所在国家或地区不支持 Xbox Live${tail}`,
        '换一个受支持地区的微软账号；网络代理改变不了账号归属',
      )
    case 2148916236:
    case 2148916237:
      return authError(
        'XSTS_ADULT_VERIFICATION',
        `账号需要通过成人验证${tail}`,
        '去 account.microsoft.com 补全出生日期与地区信息，或按页面提示完成验证',
      )
    case 2148916238:
      return authError(
        'XSTS_CHILD_ACCOUNT',
        `这是未成年账号，还没有加入家庭组${tail}`,
        '让家长在 account.microsoft.com/family 把它加入 Microsoft 家庭',
      )
    default:
      return authError('XSTS_FAILED', `XSTS 授权失败${tail}`, `错误码 ${xerr}；重新登录通常能解决`)
  }
}

/** XSTS 令牌 → Minecraft 访问令牌。 */
export async function loginWithXbox(
  xsts: XboxToken,
  opts: XboxOptions = {},
): Promise<MinecraftToken> {
  const http = opts.http ?? createHttp()
  const now = opts.now ?? ((): number => Date.now())
  const res = await http.postJson(
    MC_LOGIN,
    { identityToken: `XBL3.0 x=${xsts.userHash};${xsts.token}` },
    opts.signal,
  )

  if (res.status !== 200) {
    const desc = str(res.body, 'errorMessage') ?? str(res.body, 'error') ?? `HTTP ${res.status}`
    /**
     * 这一条不是「重试能解决」的错误，所以单独给一个码。
     *
     * 自 2023 年起，Mojang 对访问 Java 版游戏服务 API 的第三方应用**人工审核并加入白名单**，
     * 新应用在通过之前一律拿到 `Invalid app registration`（微软的报错文案指向 aka.ms/AppRegInfo，
     * 那是 Mojang 的审核说明页）。此时整条链的前四跳都是成功的，只有这一跳被拒——
     * 告诉用户「重试」等于让他白等。
     */
    if (/invalid app registration/i.test(desc)) {
      throw authError(
        'MC_APP_NOT_ALLOWLISTED',
        '这个 Azure 应用还没有被 Mojang 加入白名单，Minecraft 拒绝签发令牌',
        '去 https://aka.ms/mce-reviewappid 提交申请（人工审核，按天计）；通过之前重试没有用，' +
          '换自己的 client id 也一样，因为审核是按应用走的',
      )
    }
    throw authError(
      'MC_LOGIN_FAILED',
      `Minecraft 登录失败：${desc}`,
      '重试一次；持续失败就重新 login',
    )
  }

  const accessToken = str(res.body, 'access_token')
  const expiresIn = num(res.body, 'expires_in')
  if (accessToken === undefined) {
    throw authError('MC_LOGIN_FAILED', 'Minecraft 登录响应缺少 access_token')
  }

  return { accessToken, expiresAt: now() + (expiresIn ?? 86_400) * 1000 }
}

/**
 * 查账号档案。这是唯一能确认「这个账号真的有 Java 版」的调用。
 *
 * 404 是明确结论，不是「暂时查不到」——Mojang 用 404 表示该账号没有
 * Java 版档案（只买了基岩版的账号就是这样）。
 */
export async function fetchProfile(
  mcAccessToken: string,
  opts: XboxOptions = {},
): Promise<MinecraftProfile> {
  const http = opts.http ?? createHttp()
  const res = await http.getJson(MC_PROFILE, opts.signal, {
    Authorization: `Bearer ${mcAccessToken}`,
  })

  if (res.status === 404) {
    throw authError(
      'MC_NO_PROFILE',
      '这个账号没有 Minecraft: Java 版的档案',
      '只买了基岩版（手机/主机/Windows 商店版）的账号不能启动 Java 版；确认买的是 Java 版',
    )
  }
  if (res.status === 401) {
    throw authError('MC_PROFILE_FAILED', 'Minecraft 令牌被拒绝（401）', '重新 login')
  }
  if (res.status !== 200) {
    throw authError('MC_PROFILE_FAILED', `查询账号档案失败：HTTP ${res.status}`)
  }

  const id = str(res.body, 'id')
  const name = str(res.body, 'name')
  if (id === undefined || name === undefined) {
    throw authError('MC_PROFILE_FAILED', '账号档案缺少 id 或 name')
  }
  return { id: id.replace(/-/g, ''), name }
}

/**
 * 检查游戏所有权。
 *
 * 关键的取舍：**这个接口失败时不拦登录**。它是附加校验，不是启动的前提；
 * 因为一个 500 就把买了游戏的人拦在门外，比放过一个没买的人更糟。
 * 只有拿到明确的空清单才判定「没买」。
 */
export async function assertGameOwnership(
  mcAccessToken: string,
  opts: XboxOptions = {},
): Promise<void> {
  const http = opts.http ?? createHttp()
  const res = await http.getJson(MC_ENTITLEMENTS, opts.signal, {
    Authorization: `Bearer ${mcAccessToken}`,
  })
  if (res.status !== 200) return

  const items = (res.body as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return

  const owns = items.some((item) => {
    const name = (item as { name?: unknown } | null)?.name
    return typeof name === 'string' && /^(product_minecraft|game_minecraft)/.test(name)
  })
  if (!owns) {
    throw authError(
      'MC_NO_GAME_OWNERSHIP',
      '这个账号没有 Minecraft: Java 版的所有权记录',
      '去 minecraft.net 购买，或换一个有游戏的账号；Xbox Game Pass 里的 Java 版也算',
    )
  }
}

/** XBL 与 XSTS 的响应形状一致，解析逻辑合成一个。 */
function parseXboxToken(body: unknown): XboxToken | null {
  const token = str(body, 'Token')
  const claims = (body as { DisplayClaims?: { xui?: unknown } } | null)?.DisplayClaims
  const xui = claims?.xui
  if (!Array.isArray(xui)) return null
  const first = xui[0] as { uhs?: unknown; xid?: unknown } | undefined
  const uhs = typeof first?.uhs === 'string' ? first.uhs : undefined
  if (token === undefined || uhs === undefined) return null
  const xuid = typeof first?.xid === 'string' ? first.xid : undefined
  return { token, userHash: uhs, ...(xuid === undefined ? {} : { xuid }) }
}
