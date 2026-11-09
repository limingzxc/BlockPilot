# 0001. 编排层以事件流暴露，CLI / MCP / GUI 作为多消费者

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Supersedes**: —

## Context

BlockPilot 的定位是**开源参考实现**，不是商业产品。衡量成功的标准不是「有多少玩家在用」，而是「有多少人读完代码后能把这套架构抄进自己的启动器」。

第一阶段不做 GUI，只做 CLI + MCP server。但 GUI 一定会来（否则无法向非技术用户证明这套东西是可行的）。核心约束是：**加 GUI 不能导致重写。**

调研过的既有实现（2026-10-25）：

| 项目 | 许可 | ★ | 为什么不直接用它当底座 |
|---|---|---|---|
| HMCL | GPL-3.0 | 10.7k | `HMCLCore` 零 JavaFX 依赖，是块好料；但 GPL 锁死复用，且 JavaFX 写聊天式 UI 成本高 |
| PrismLauncher | GPL-3.0 | 10.9k | C++/Qt，AI 层只能插 sidecar；同上 GPL |
| PandoraLauncher | MIT | 942 | 最干净的 MIT 完整启动器（含日志 token 脱敏），但自述 WIP |
| XMCL | MIT | 1.7k | `runtime` / `instance` / `java-runtime` / `mod-resource` 四个包未发布 npm（实测 404），用它等于 fork monorepo |
| ProjBobcat | MIT | 261 | 自带崩溃规则表 + Modrinth/CF 客户端，能力最省时；但一人维护、13 个模块，是阅读负担 |
| Trident.Net | MIT | 7 | **架构最正确**（Operations 层被 CLI 与 MCP 共用），但 7★ 无社区验证 |

结论：**没有可直接加 AI 的现成底座，编排层必须自己造。** 而编排层的形态，决定了未来所有消费者能不能复用。

## Decision

### 1. 技术栈：TypeScript / Node 20+

- MCP 官方 SDK（`@modelcontextprotocol/sdk`）与 Vercel AI SDK 均以 TS 为第一优先级；后者的 `fullStream` 直接产出 `tool-call` / `tool-result` 事件，是「AI 驱动」最省事的一层。
- `@xmcl/{core,installer,user,mod-parser,modrinth}` 全部为 MIT、纯 Node（不依赖 Electron）、且**发布在 npm**。刻意排除未发布的 `runtime` / `instance`——它们恰好就是编排层，而这正是本项目的参考价值所在。

### 2. 三层结构，core 不认识 stdout

```
core/    纯逻辑：解析、求解、下载编排、状态读写
  ├── cli/      进程内消费者，把 OpEvent 渲染成人类可读文本
  └── mcp/      独立进程，把 OpEvent 转成 notifications/progress + 工具返回
      └── gui/  （未来）第四个消费者，不改 core
```

`core` 内**禁止**出现 `console.log`、`process.stdout`、`process.exit`。所有输出必须经由事件。

### 3. 唯一出口契约

```ts
export type OpEvent =
  | { type: 'progress'; taskId: string; done: number; total: number; label: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; code: string; data?: unknown }
  | { type: 'artifact'; path: string }
  | { type: 'failed'; code: string; message: string; hint?: string }
  | { type: 'done' }

export interface Operation<T = void> {
  readonly id: string
  run(signal: AbortSignal): AsyncIterable<OpEvent>
}
```

`Operation` 必须满足三条：**可取消**（响应 `AbortSignal`）、**可重入**（失败后重跑不会产生半成品）、**可观察**（每个阶段都有事件）。

### 4. 状态落盘，不留内存

CLI 的习惯是「跑完退出，状态无所谓」。但 GUI 用户会关窗口、会断网、会点取消。实例配置、任务记录、已装内容清单必须是磁盘上的持久状态，CLI 只是它的一个读写者。

### 5. AI 能力边界：六组工具，不含 run 与 OAuth

MCP 暴露六组（沿用 Trident.Net 的划分）：

| 组 | 能做什么 | 不能做什么 |
|---|---|---|
| `instance` | 创建 / 删除 / 列出实例、改配置 | 启动游戏 |
| `package` | 装版本 / 加载器 / 模组 / 整合包 | — |
| `config` | 读写游戏配置、JVM 参数 | — |
| `repository` | 查版本清单、搜模组、查依赖 | — |
| `account` | 列出已登录账户、查登录状态 | **发起 OAuth、读 token** |
| `loader` | 查加载器版本、兼容性 | — |
| `diagnose` | 静态预检、读崩溃报告、查兼容性（0002 引入） | 修好它——修复必须由人确认后另行发起 |

**现状（2026-11-09）**：MCP 实际只交付了 `preflight_modpack` 与 `diagnose_crash`
两个只读工具；上表其余四组是方向，不是已交付能力。ADR-0040 没有扩大这个范围。

**启动游戏（run）与账户授权（OAuth）刻意不暴露给 AI。** 理由是这两个操作不可幂等、不可回滚：AI 装错模组可以删，但 AI 用你的账号启动一次游戏，无法撤销。这条边界必须写进协议，不能靠 prompt 约束。

## Consequences

**Positive**

- 加 GUI = 写第四个消费者，core 一行不改。
- CLI 天然可被脚本 / CI 调用；MCP server 天然可被任何 AI 客户端（Claude Desktop、Cursor、自研 agent）接入。
- `core` 可被别的启动器直接 `import`——这是参考实现真正的产出物。

**Negative**

- 事件流比同步函数啰嗦；团队需要忍住「这里直接 console.log 更快」的冲动。
- 进度事件要节流（一次安装会产生数百条文件级事件，直接透传会淹掉消费者）。
- 无 GUI 期间无法向非技术用户演示。
- stdio MCP 与未来的 Web GUI 之间需要一层桥（HTTP/WS），**这层必须在架构图里预留位置**，否则前端会退化成直接 import core 的 Node 模块，打包时炸掉。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| fork HMCL / Prism | 参考实现要能被读懂，10 万行 C++/JavaFX 做不到；GPL 也会锁死复用者的选择 |
| C# + ProjBobcat 做底座 | 能力最省时，但 MCP / AI SDK 生态弱一档，且 .NET 桌面受众远小于 Node |
| 先做 GUI，再抽 core | UI 逻辑会渗进业务层，事后抽离的成本高于从零分层 |
| 同步函数 + console.log | 这正是「将来加 GUI 要重写」的那条路 |

## Decisions closed on 2026-10-25

| 问题 | 决定 | 理由 |
|---|---|---|
| 许可证 | **MIT** | 与 @xmcl / CmlLib / ProjBobcat / Pandora / Trident 一致；参考实现不该给复用者加法律负担 |
| 第一个能力 | **启动前预检**（见 ADR-0002） | 崩溃分析已有五家在跑；整合包识别可以从预检的输入解析中派生 |
| 第二个后端实现 | **不做** | YAGNI。接口留出可能性，但不写第二份实现 |
| @xmcl 维护风险 | **适配层隔离**，不 fork | core 内定义 `VersionSource` / `ContentSource` / `JvmProvider` 三个接口，@xmcl 只是默认实现。它死了，换一个 adapter 即可，业务层不动 |
