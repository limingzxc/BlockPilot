# 0039. 内置 BlockPilot 自己的 Azure 应用 id

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Depends on**: ADR-0024、ADR-0038

## Context

ADR-0024 的结论是「client id 必须由使用者自己注册」，理由是任何硬编码的第三方 id 都是冒充。
这条在**项目还没有自己的应用**时是对的，代价是把一次 15 分钟的设备码流程，前面又加了一道
门户注册手续：想进正版服务器的玩家要先读四步文档、在 portal.azure.com 点完、记下 client id、
设好环境变量，才能开始登录。

那个理由现在不成立了——BlockPilot 有了自己的应用注册：

| 项 | 值 |
|---|---|
| 显示名称 | BlockPilot |
| 应用程序(客户端) ID | `d2f40521-2892-4555-bb2d-11cd748dedf6` |
| 目录(租户) ID | `94b655d8-0703-49dc-97ab-c0070400402e` |
| 账户类型 | 所有 Microsoft 帐户用户 |
| 公共客户端流 | 开启 |
| 委托权限 | `XboxLive.signin` |

## Decision

### 1. 内置为默认值，而不是唯一值

`resolveClientId()`（`core/auth/app.ts`）：`--client-id` > `BLOCKPILOT_CLIENT_ID` > `DEFAULT_CLIENT_ID`。

空串与纯空白按「没给」处理。Windows 上 `--client-id ""` 会真的传进来一个空串，
把它当合法值会得到一条指向空 id 的 AADSTS 错误，而不是悄悄回落到默认值——用户看到的是
「认证失败」，不是「你的参数是空的」。

### 2. 为什么硬编码是安全的

设备码属于**公共客户端**，没有 client secret。这个 id 天生公开：任何人在门户的「概述」页
都能看到自己应用的 id。泄露它换不到任何东西，它只能发起一次需要用户在浏览器里点同意的授权。

真正不能硬编码的是**别人的** id（官方启动器、PCL、HMCL 的）——那会让微软以为请求来自那个应用。
ADR-0024 反对的是冒充，不是「项目用自己的应用」。

### 3. 租户仍然是 `consumers`

应用注册的账户类型是「所有 Microsoft 帐户用户」，但请求照旧打 `/consumers`（`msa.ts` 的 `AUTHORITY`）。
Minecraft 只认个人微软账号，组织账号走到 XSTS 必然失败；早一步把范围限死，报错才准确。
这个组合已实测可用（见「验证」）。

## Consequences

**Positive**

- `blockpilot login` 零配置可用，README 的「正版登录」从四步门户操作缩成一条命令
- 想换自己的应用仍是一行 `BLOCKPILOT_CLIENT_ID`，没有变难
- client id 的解析只有一处，`login` 与未来的 GUI 不会各写一遍优先级

**Negative**

- **单点**：这个应用被微软停用（滥用举报、租户异常）时，所有用户的 `login` 一起坏，
  而且只能等发版才能换 id
- 应用挂在维护者的租户下，配额与合规责任也落在那里
- fork 必须改常量，否则就是在用 BlockPilot 的应用——这条要写进 CONTRIBUTING
- **审核是前置条件**：Mojang 白名单没下来之前，内置 id 只是「装好了但登录不了」，
  而且这个状态只能靠报错文案传达，不能靠代码绕过

## 验证

- **应用配置**（2026-11-09，真实请求）：`POST /consumers/oauth2/v2.0/devicecode` 返回 200，
  带 `user_code` / `verification_uri` / `interval`。这一条同时证明了三件事：id 有效、
  公共客户端流已开（否则 `AADSTS7000218`）、`XboxLive.signin` 被接受
- **scope 确实被校验**：把 scope 换成 `Definitely.Not.A.Scope` 得到 `invalid_scope`（70011）。
  说明上一条的 200 不是「什么都收」，Xbox Live 权限确实配上了
- **设备码 → MSA 令牌**：真实账号在浏览器里完成授权，轮询拿到 access_token + refresh_token。
  这一跳此前只有假 `HttpClient` 覆盖
- **端到端登录**（2026-11-09，真实账号）：设备码 → MSA → XBL → XSTS **四跳全通**，
  最后一跳 `login_with_xbox` 返回 `Invalid app registration`。
  这不是代码问题：Mojang 自 2023 年起对访问 Java 版游戏服务 API 的第三方应用**人工审核并加入白名单**，
  新应用在通过前一律被拒（报错文案指向的 `aka.ms/AppRegInfo` 就是 Mojang 的审核说明页）。
  应用已提交申请，等待审核。**所以「一次成功的登录」仍未完成，且不由代码决定。**

### 白名单是这个决定的硬前提

内置 client id 只有在**这个应用通过 Mojang 审核之后**才真正可用。审核按应用走，
fork 换 id 也得各自申请。审核期间 `login` 会稳定失败在最后一跳，因此报错必须说清
「不是账号问题、不是网络问题、重试没用」——`MC_APP_NOT_ALLOWLISTED` 就是为此加的，
hint 直接给申请表单 `aka.ms/mce-reviewappid`。

### 顺带修掉的 bug：XBL 缺 `AuthMethod`

`user.auth.xboxlive.com/user/authenticate` 的 `Properties` 里必须有 `AuthMethod: "RPS"`。
缺了它，服务端返回 **HTTP 400 且响应体为空**，客户端只能报「HTTP 400」，看起来像令牌失效。
用同一份**无效**令牌做对照，差别就出来了：

| 请求形状 | 结果 |
|---|---|
| 无 `AuthMethod`（修复前） | 400，响应体 0 字节 |
| 加 `AuthMethod: "RPS"` | 401 —— 语义正确的「令牌无效」 |
| 再加 `x-xbl-contract-version: 1` | 401，无变化（这个头不是必需的） |

这也是一个测试盲区：假 `HttpClient` 不校验请求体，23 个测试全绿而 bug 仍在线上。
修复后补了断言钉住 `AuthMethod`，并把 401 与其它状态分开报——401 才是「令牌被拒」。

## 不做

- **不发 client secret**：公共客户端 + 设备码的全部意义就是没有 secret，发一个就等于把它变成机密客户端，还得处理「secret 怎么送到用户手上」
- **不把 client id 挪进配置文件**：多一个文件就多一个「文件不存在 / 格式写错」的失败面，而它本来就不需要保密
- **不支持组织账号**：Minecraft 不支持，放开只会把失败推迟到 XSTS 那一步，报错更难懂
- **不给 MCP 暴露 login**：ADR-0024 的结论不变——授权必须在浏览器里由人完成
