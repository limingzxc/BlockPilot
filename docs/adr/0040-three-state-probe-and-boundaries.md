# 0040. 三态探测、令牌脱敏与路径 / 下载边界

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0001（事件流）、ADR-0005（哈希是唯一裁判）、ADR-0012（重跑安全）、ADR-0035（Legacy Fabric）、ADR-0037（报告装配）

## Context

一次外部架构评审逐条对照了代码与 ADR，发现的问题可以归成三类：

1. **会「说错话」**：`T | null` 把「对方明确说没有」与「根本没连上」压成一个值。  
   `adoptium.ts` 的 `catch { return null }` 会把断网报成 `JAVA_NOT_FOUND`；  
   `recommendedForge`、`fetchMavenSha1`、`detectFabricFlavor` 同理。这直接违反  
   「只说有证据的话」这条项目底线。
2. **有安全风险**：`launch --raw` 打印真实 `--accessToken`；1.6.x 的  
   `Session ID is token:<token>:<uuid>` 落进会话日志，而日志会被 `diag` 与 MCP 读给 AI。  
   mrpack 的 `downloads` 没有域名白名单，恶意包可以让用户机器请求内网地址。  
   路径穿越有四份各自实现，`includes('..')` 还会误杀 `foo..bar.jar`。
3. **工程一致性**：`engines` 写 Node 20、lockfile 里 undici 8 要求 22.19；错误类型  
   六套、`reportFatal` 靠 `instanceof` 阶梯；`exactOptionalPropertyTypes` 没开，  
   但全仓库都在写 `...(x === undefined ? {} : { x })`。

## Decision

### 1. 探测返回三态

新增 `core/probe.ts`：

```ts
type Probe<T> =
  | { status: 'found'; value: T }
  | { status: 'absent'; detail?: string }
  | { status: 'unreachable'; detail: string }
```

`fetchJavaBinary` / `recommendedForge` / `fetchMavenSha1` / `detectFabricFlavor` 全部改成  
返回 `Probe`。调用方分别映射：

| 状态            | Java             | 加载器版本                  | sha1            | Fabric 版本列表             |
| ------------- | ---------------- | ---------------------- | --------------- | ----------------------- |
| `found`       | 继续下载             | 继续安装                   | 继续下载            | 继续安装                    |
| `absent`      | `JAVA_NOT_FOUND` | `NO_INSTALLER_VERSION` | `NO_HASH`       | `NO_FABRIC_FOR_VERSION` |
| `unreachable` | `NETWORK_ERROR`  | `NETWORK_ERROR`        | `NETWORK_ERROR` | `NETWORK_ERROR`         |

判定规则：4xx（429 除外）算 `absent`；429、5xx、DNS/超时/代理失败算 `unreachable`。  
4xx 里 400 也按 absent——Fabric 官方 meta 对不支持的版本正是返回 400 + 空数组。

### 2. 令牌在生产文本的那一处脱敏

新增 `core/redact.ts`，覆盖 `--accessToken <v>`、`"accessToken":"..."`、  
`Authorization: Bearer ...`、`token:<token>:<uuid>` 四种形状。

落点只有三处，都是**文本产生处**：

- `buildLaunchPlan` 的 `commandLine`（展示用；`args` 保留真实令牌，启动必需）
- `launch` 的 `compactArgs`（`--raw` 也走这里）
- `run.ts` 的每一行游戏输出，**在进 tail / 会话日志 / OpEvent 之前**
- `crash.ts` 的 excerpt 与 message（旧日志可能还没脱敏）

消费者不再各自擦一遍；`diag` 与 MCP 拿到的文本天然是干净的。

`--events` 是给自动化消费者的，`result` 里可能带 `LaunchPlan.args`（执行必需）
与登录账号的 `accessToken` / `refreshToken`。emit 层（`cli/ui.ts`）再做一次兜底：
字段名命中令牌的替换成 `***`，`args` 数组按 `--accessToken` 成对脱敏，
所有字符串再过一遍 `redactSecrets`。人类文本统一走 `say()`，事件模式下改道 stderr。

### 3. 路径拼接只有一个入口

新增 `core/safe-path.ts` 的 `safeJoin(base, rel)`：按路径段拒绝 `..`、绝对路径、  
盘符与 UNC，再用 `resolve` 后的前缀做最后一道校验。zip / tar / mrpack / natives  
五处解压全部改用它。`foo..bar.jar` 合法，`..\..\x` 非法。

### 4. mrpack 下载域名白名单

默认只允许 Modrinth 规范列出的域名（`cdn.modrinth.com`、`github.com`、  
`raw.githubusercontent.com`、`objects.githubusercontent.com`、`gitlab.com`）。  
白名单外的条目**不下载，但计入 failed**——静默少装一个模组比报错更糟。  
`--allow-host`（逗号分隔，支持 `.suffix` 后缀匹配）用于本地服务测试与私有镜像；  
E2E-401 已显式放行 `127.0.0.1`。

### 5. overrides 默认不覆盖

`extractOverrides` 默认跳过磁盘上已存在的文件，并在结果里计 `skipped`；  
`--overwrite-overrides` 才覆盖。同一次运行内 `client-overrides` 仍然覆盖  
`overrides`（用 `written` 集合区分「本次刚写的」与「用户原有的」）。  
这样 ADR-0012 的「重跑安全」才名副其实。

### 6. CurseForge 的契约回到 core

`CfFileInfo` / `CurseforgeLike` / `CurseforgeError` / `cfFileToVersionInfo` 搬到  
`core/curseforge.ts`；`src/sources/curseforge.ts` 只保留 HTTP 客户端与  
`resolveCurseforge`（有 key 走官方、没 key 走镜像），由 CLI / MCP 注入。  
core 里的兜底是 `unconfiguredCurseforge`（`configured: false`），不再自己 new 实现。

`src/core/architecture.test.ts` 扫描 core 的所有相对 import，禁止指向  
`src/sources/`、`src/cli/`、`src/mcp/`。这是没有 lint 时的替代品。

### 7. 错误统一成 `BlockPilotError`

CurseForge 的 429 / 5xx 现在退避重试两次（`fetchRetrying`）。免 key 的镜像路径是  
271 次 GET，以前任意一次 429 都会终止整轮解析。

`core/errors.ts` 提供 `BlockPilotError { code, message, hint }`、`errMessage()`、  
`asBlockPilotError()`。`NetworkError` / `LayoutError` / `VersionNotFoundError` /  
`CurseforgeError` / `AuthError` / `UsageError` 全部继承它；`collect()` 抛出的错误  
保留 `failed` 事件的 code 与 hint；`reportFatal` 的 `instanceof` 阶梯缩成一条通用分支。

### 8. 工程一致性

- `engines.node` → `>=22.19.0`（undici 8 的真实要求），README 同步；CI 加 Node 24。
- `package-lock.json` 的 150 个 `resolved` 从 `registry.npmmirror.com` 换回  
  `registry.npmjs.org`。
- 开启 `exactOptionalPropertyTypes`，并修掉 13 处真实的可选属性错误  
  （`...(x === undefined ? {} : { x })` 从此是有意义的写法）。
- `DownloadSource` 改名为 `Mirror`，与 GLOSSARY 的 Source / Mirror 对齐。
- `assembleReport` 接受注入时钟；`Finding` 增加可选 `data` 结构化字段。
- `.part` 文件名带 pid；离线 UUID 按 `OfflinePlayer:<name>` 派生；  
  `checkMemory` 使用一直采集却没用过的 `totalMemoryMiB`。

### 9. 事件与 Finding 的码表

- `events.ts` 新增 `LogCode`（全部合法事件码）与 `LogPayloads`（code → data 形状）。  
  `Op.log` 按 code 推断 data，`LogEvent` 是按 code 判别的联合：消费者  
  `if (ev.code === 'deploy.step')` 之后 `ev.data.step` 直接是 `DeployStep`。  
  CLI 里 17 处 `ev.data as { file?: string … }` 随之删除。
- `preflight/types.ts` 新增 `FINDING_CODES` 与 `FindingCode`；`Finding.code` 从  
  `string` 收紧成联合类型。`docs/finding-codes.md` 列出每个码的含义与默认级别，  
  由 `src/core/preflight/codes.test.ts` 与代码表双向校验。
- 顺手收敛了纯历史叙事的注释（「以前……怎么错」），保留「为什么现在这样」；  
  ADR 与提交信息负责记录历史。

## Consequences

**Positive**

- 断网不再被说成「没有这个构建」；用户看到的下一步从「换 Java 版本」变成「查网络」。
- 令牌不会经 `--raw`、会话日志、`diag`、MCP 四条路泄漏。
- 恶意 mrpack 不能再让用户机器请求任意 host；路径穿越只剩一份实现。
- 重跑 deploy 不会冲掉用户配置，除非显式要求。
- 新增错误类型不必再改 `reportFatal`。

**Negative**

- `Probe` 比 `T | null` 多一层解包；四个调用点的分支变长（但每个分支都有独立文案）。
- 默认域名白名单会挡住少数自建 CDN 的整合包，用户需要加 `--allow-host`。
- 默认不覆盖 overrides 意味着「更新包里的配置」要显式加 flag。

## Alternatives considered

| 方案                                              | 否决理由                                  |
| ----------------------------------------------- | ------------------------------------- |
| 保留 `T \| null`，在 catch 里返回带 `unreachable` 字段的对象 | 还是同一个形状，调用方仍可能只看 `null`               |
| 只在 CLI 渲染层脱敏                                    | `diag` / MCP / 会话日志各自都会读原始文本，漏一条就泄漏   |
| 白名单只警告不拦截                                       | 请求已经发出去了，SSRF 的目的已达成                  |
| 重跑时写 `.bak` 再覆盖                                 | 用户改过的 `options.txt` 仍然被换掉；跳过更符合「重跑安全」 |

## 验证

- `src/core/redact.test.ts`：四种令牌形状、幂等、参数成对处理
- `src/core/safe-path.test.ts`：`foo..bar` 合法、盘符 / UNC / 反斜杠穿越拒绝
- `src/core/setup/pack.test.ts`：白名单拦截内网地址、`--allow-host` 放行、  
  overrides 默认跳过与 `overwrite` 覆盖
- `src/core/launch/uuid.test.ts`：`Notch` / `Steve` 已知向量
- `src/core/preflight/check.test.ts`：`LOW_MEMORY` 的三条边界
- `src/cli/readme.test.ts`：README 命令表与 `COMMANDS` 集合一致
- `src/core/architecture.test.ts`：core 不得 import `src/sources/`、`src/cli/`、`src/mcp/`
- `src/core/preflight/codes.test.ts`：`FINDING_CODES` 与 `docs/finding-codes.md` 一致、无重复
- `npm run typecheck`（含 `exactOptionalPropertyTypes`）、`npm test`、`npm run e2e -- --tier 0`

## 不做

- **不把 `defineOperation` 改成自动捕获异常**：把内部 bug 统一转成 `Op.failed`  
  会让「不该发生的错误」看起来像「可预期的失败」，掩盖堆栈。错误仍在边界处  
  （`collect` / CLI / MCP）转换。
- **不拆 workspace**：`core` / `cli` / `mcp` 拆包需要改构建与发布。已补最小公共面
  （`src/index.ts` + `package.json` 的 `main` / `types` / `exports`），别的项目可以
  `import { createPreflight, Op } from 'blockpilot'`；拆包仍留作后续。
- **`update` 仍不做**：`lock.json` 与 `verify` 已由 ADR-0041 落地；按 lock 找新版本  
  牵涉 Modrinth / CurseForge 的版本解析与加载器升级，是下一个独立特性。
- **`--events ndjson` 已落地**：本次补齐了 emit 层脱敏、人类文本改道 stderr、
  串联多个 Operation 时只写一次 `exit`；异常路径也会补 `failed` + `exit`。
