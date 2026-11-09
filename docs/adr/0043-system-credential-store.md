# 0043. 系统凭据存储（可选后端）

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0024（微软认证）、ADR-0040（本次边界）

## Context

ADR-0024 的现状是：`refresh_token` 明文写进 `<root>/auth/accounts.json`，权限 0600。
理由是不引 `keytar` 这类原生模块——它会把「参考实现」变成「需要编译的工程」。

代价也写在 ADR 里：**能读到这个文件的人就能接管账号**。这是本项目目前最大的
单点安全风险。

## Decision

不引原生依赖，改用**各平台自带的命令行工具**：

| 平台 | 后端 | 实现 |
|---|---|---|
| Windows | DPAPI | PowerShell 调 `ProtectedData.Protect/Unprotect`，密文绑定当前用户 |
| macOS | 登录钥匙串 | `security add-generic-password` / `find-generic-password` |
| Linux | Secret Service | `secret-tool store/lookup/clear` |

`createCredentialStore(authDir)` 返回 `CredentialStore | null`。null 表示没有可用
后端（工具缺失、无桌面会话、被锁），调用方继续用 0600 文件。

### 存档规则

- `saveStore(path, store, credentials)`：对每个带 `refreshToken` 的账号调用
  `credentials.set(uuid, token)`；**成功**才把 `refreshToken` 从 JSON 里去掉。
- `loadStore(path, credentials)`：按 uuid 取回 `refreshToken`，合并进账号对象。
- `removeAccount`：先 `credentials.delete(uuid)`，再写存档。
- `set` 失败时保留文件里的 token，不制造「以为存了其实没存」。

`AuthAccount` 的形状不变，`refreshToken` 仍是可选字段；只是它可能来自钥匙串
而不是 JSON。`accessToken` 仍然落盘（24 小时短期凭证），避免每次启动都做一次
钥匙串读取。

## Consequences

**Positive**

- 有可用后端时，长期凭证不再以明文出现在可备份/可同步的目录里。
- 没有原生依赖；三个平台都用系统自带工具，`npm install` 不增加编译步骤。
- 后端不可用时行为与之前完全一致（0600 文件），不会让用户无法登录。

**Negative**

- Windows 的 DPAPI 密文仍是文件，只是绑定当前用户；换用户/换机器读不了，
  但同用户的恶意进程仍可调用 DPAPI 解密。
- 每次 `loadStore` 对每个账号调一次 `security` / `secret-tool`，多几十毫秒。
- 三个平台的后端无法在本机同时实测；macOS/Linux 只做了代码路径与降级逻辑，
  需要在真机上补一次手工验证。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| `keytar` / `@napi-rs/keyring` | 原生模块，破坏「参考实现」的零编译承诺 |
| 自己用 AES + 固定密钥加密 | 密钥还得落盘，只是把明文换成另一份明文 |
| 不存 refresh_token，每次启动重新登录 | 设备码流程 15 分钟，不可接受 |

## 验证

- `src/core/auth/store.test.ts`：有后端时不落盘、load 取回、set 失败回退、remove 清理
- `src/core/auth/credentials.test.ts`：Windows DPAPI 往返（非 Windows 跳过）
- macOS / Linux：`createCredentialStore` 探测失败返回 null；成功路径需真机验证
