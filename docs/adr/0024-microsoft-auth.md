# 0024. 正版登录：设备码 + 自己的 Azure 应用

- **Status**: Accepted（链路已实现并有 23 个测试；**真实登录未实测**，见「验证边界」）
- **Date**: 2026-10-27
- **Deciders**: @liming
- **Depends on**: ADR-0002、ADR-0010

## Context

在此之前所有启动都是离线模式：`uuid` 全零、`accessToken` 写 `'0'`、`userType=legacy`。
游戏能进主菜单、能玩单人，但**进不了任何正版服务器**——而这是绝大多数玩家的第一需求。
它不是「功能缺失」，是「这个核心还没法被真实玩家使用」。

正版登录要解决的问题比看起来多：

1. 微软账号 → Xbox Live → XSTS → Minecraft 是**三跳**，每跳的令牌只对下一跳有效
2. 第三方启动器**不能**复用官方启动器的 Azure 应用 id（那是冒充）
3. 刷新令牌是**一次性**的，每次使用都会换新的，旧的随后失效
4. XSTS 的失败有十几个语义完全不同的错误码（没档案、未成年、地区限制、成人验证）

## Decision

### 1. 设备码流程，不内嵌浏览器

```
用户看到：  打开 https://microsoft.com/link  输入 AB12-CD34
我们拿到：  device_code（轮询用）+ refresh_token（离线续命用）
```

不选内嵌 WebView / 本地回调服务器，理由不是实现难度：**参考实现不该让用户在一段无法审查的代码里输微软密码**。设备码把凭据留在微软自己的页面上，密码永远不经过我们。

代价是用户要多做两步（开浏览器、输码）。对一个装整合包的玩家，这比「一个盖在游戏上的登录框」更可信——他看得见地址栏。

### 2. client id 必须由使用者自己注册

`AUTH_NO_CLIENT_ID` 是**默认状态**，不是配置疏漏。任何硬编码的第三方 client id 都是冒充别人的应用。

注册一次即可（免费），要求三项：

| 项 | 值 |
|---|---|
| 账户类型 | 个人 Microsoft 账号（consumers 租户） |
| 重定向 | 不需要（设备码属于公共客户端） |
| 允许公共客户端流 | **必须开启**，否则 `devicecode` 直接 400 |
| API 权限 | 委托权限 `XboxLive.signin`（`offline_access` 随 scope 自动授予） |

传参：`--client-id <uuid>` 或环境变量 `BLOCKPILOT_CLIENT_ID`。

### 3. 五步链，端点固定

```
login.microsoftonline.com/consumers/oauth2/v2.0/devicecode   → 设备码
login.microsoftonline.com/consumers/oauth2/v2.0/token        → MSA 令牌（轮询）
user.auth.xboxlive.com/user/authenticate                     → XBL（RpsTicket=d=…）
xsts.auth.xboxlive.com/xsts/authorize                        → XSTS（RelyingParty=rp://api.minecraftservices.com/）
api.minecraftservices.com/authentication/login_with_xbox      → MC 令牌（XBL3.0 x=<uhs>;<xsts>）
api.minecraftservices.com/entitlements/mcstore               → 是否拥有游戏
api.minecraftservices.com/minecraft/profile                  → uuid 与玩家名
```

三个「写错就静默失败」的细节，全部有注释与测试：

- `RpsTicket` 必须带 `d=` 前缀，否则 XBL 把令牌当 Compact 票据拒绝
- `RelyingParty` 必须是 Minecraft 的，写成 `http://auth.xboxlive.com` 会在 XSTS 处 400
- `identityToken` 的形状是 `XBL3.0 x=<uhs>;<token>`，不是裸 token

**所有权检查刻意放在档案查询之前**：只买了基岩版的账号也有 Xbox 档案，但没有 Java 档案。顺序反过来会把「没买 Java 版」报成「没有档案」，指错方向。

**所有权接口故障时不拦登录**（500 就跳过）。它是附加校验，不是启动前提；因为一个 500 把买了游戏的人拦在门外，比放过一个没买的人更糟。只有拿到明确的空清单才判定「没买」。

### 4. 存档明文，权限 0600

`<root>/auth/accounts.json`，只存「够启动 + 够刷新」的字段：uuid / name / accessToken / expiresAt / xuid / refreshToken / clientId。

不引系统钥匙串（keytar 之类）的原因：它是原生模块，会把「参考实现」变成「需要编译的工程」，还得为三个平台各准备一份二进制。代价必须说清——**能读到这个文件的人就能接管账号**。所以：

- 写文件用 `mode: 0o600`，Windows 上尽力而为
- 先写 `.tmp` 再 rename：中断不会留下半截 JSON（一次 Ctrl+C 就让用户「存档损坏」是不可接受的）
- 不写进 git、不写进日志、不打印令牌（CLI 只显示名字与 uuid）

### 5. 刷新走完整三跳

`refresh_token → MSA → XBL → XSTS → MC`，而不是「只换 MC 令牌」。因为 MC 令牌一旦过期，就不能拿它去续 XSTS，而 XSTS 是每次启动必换的。既然横竖要重走，就不维护「XSTS 还在有效期」这个额外状态——多一个状态就多一个过期判断写错的地方。

刷新后**必须写回新的 refresh_token**，否则下次刷新失败，用户看到的是「昨天还好好的，今天又要重新登录」。

过期判定留 **60 秒余量**：正好在到期瞬间启动，走到游戏里就过期了，表现为「连上了但进不去服务器」。

### 6. 两种失败语义

| 场景 | 行为 | 理由 |
|---|---|---|
| 默认账号刷新失败 | **退回离线**并说明原因 | 玩家多半只想玩单人，拦在门口没有意义 |
| `--account` 点名的账号不可用 | **失败退出（exit 1）** | 他明确要在线身份；悄悄用离线身份进去，朋友会看到「这不是你」 |

`--offline` 是显式逃生口，永远不问存档。

## Consequences

**Positive**

- 正版身份进游戏：`--uuid` / `--accessToken` / `--xuid` / `--userType msa`（写 `legacy` 会让游戏忽略令牌）
- 令牌过期自动续，用户只在 refresh_token 失效（改密码、撤销、90 天未用）时才需要重新登录
- XSTS 的 4 类错误码各有可执行建议，不是笼统的「认证失败」

**Negative**

- 需要使用者注册一次 Azure 应用——这挡住了「下载即用」，接受它，因为替代方案是冒充
- 令牌明文落盘
- 21 个新测试全部走假 `HttpClient`，真实链路只有端点存活证明

## 验证边界

**已验证**

- 三个端点存活：`devicecode` 对假 client id 返回 `AADSTS700038: not a valid application identifier`，
  未注册的 UUID 返回 `AADSTS700016`——说明请求形状被接受，只差合法应用
- 整条链在假 `HttpClient` 上跑通，覆盖：轮询的 `authorization_pending` / `slow_down` / 拒绝 / 过期、
  XSTS 的 2148916233 / 2148916238、所有权空清单、档案 404、刷新令牌轮换、存档原子写与损坏处理
- `launch` 的身份参数实测：正版账号产出 `--uuid 069a…` / `--accessToken …` / `--xuid …` / `--userType msa`

**未验证**

- **一次真实登录**。缺两个前提：一个注册好的 Azure 应用 id、一个有 Java 版 Minecraft 的微软账号。
  两样都只能由使用者提供，因此 `login` 的「成功路径」只被假适配器覆盖过，
  和 NeoForge 当初「代码就绪、未实测」是同一类诚实标注。

## 不做

- **MCP 暴露 login**：登录必须在浏览器里完成，把设备码交给模型没有意义；
  MCP 仍然只有 `preflight_modpack` 与 `diagnose_crash` 两个只读工具
- **账号切换器 GUI**：`--account` 与 `accounts` 已够用
- **皮肤/披风上传**：不属于「启动」这件事
