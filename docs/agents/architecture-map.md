# 架构与改动落点

改代码前先看这张表：每类改动都有固定的几个落点，漏一个通常不会立刻报错，但会在下一次
`verify` / `update` / 消费端暴露。路径都相对仓库根。

## CLI 模块结构

consumer 内部按职责分层，依赖只能向下：

```
commands/<name>.ts   具体命令：声明 + handler
        │
        ├─> command/         define（声明/校验）、context（惰性 layout/sources）、usage（帮助）、flags / common-flags（flag 形状与共享 flag）
        ├─> consume/         OpUi / consume / consumeValue / createInterrupt
        ├─> output/          ansi（颜色/字节）、stream（--events 协议）、progress（TTY 进度）
        ├─> render/          纯渲染：core 类型 + ansi，不碰消费器与命令声明
        ├─> shared/          args（位置参数/数值校验）、errors（UsageError）
        └─> use-cases/       auth（账号解析/登录/离线名）、java（挑 Java）、loader（加载器装配）、instance（实例配置）、deploy（deploy 装配）

main.ts              全局 flag（--proxy / --events）+ 分发 + 致命错误映射
registry.ts          全仓唯一知道所有命令的地方
index.ts             仅入口守卫：判断是否被直接执行
```

| 目录 / 文件 | 职责 | 不允许做的事 |
|---|---|---|
| `src/cli/commands/` | 单条命令的声明与流程 | import 入口、注册表或其他命令 |
| `src/cli/command/` | 声明形状、上下文、帮助文本、共享 flag | 知道任何具体命令 |
| `src/cli/consume/` | 事件流 → 退出码 / 结果 | 直接写人类文本（走 output） |
| `src/cli/output/` | 输出协议与格式化 | 依赖 render / consume / commands |
| `src/cli/render/` | 把 core 数据渲染成人类可读文本 | 依赖 consume / command / 入口 |
| `src/cli/shared/` | 无状态的参数解析与错误类型 | 组合业务用例 |
| `src/cli/use-cases/` | 命令级业务组合（装配、选择），不写输出 | 被 core 反向依赖 |
| `src/cli/main.ts` | 进程级参数、分发、错误映射 | 实现具体命令 |
| `src/cli/registry.ts` | `COMMANDS` 汇总 | 实现具体命令 |
| `src/cli/index.ts` | 入口守卫 | 业务逻辑、命令清单 |

## 改动落点

| 要改什么 | 必须一起改的地方 |
|---|---|
| 新增/修改 CLI 命令 | `src/cli/commands/<name>.ts`（`defineCommand` + handler，只做声明与渲染）、`src/cli/command/common-flags.ts`（共享 flag）、`src/cli/registry.ts` 的 `COMMANDS` 汇总、`src/cli/command/`（声明/上下文/usage）、`README.md` 命令表（`src/cli/readme.test.ts` 会校验）。装配放 `src/cli/use-cases/<name>.ts`，渲染放 `src/cli/render/<name>.ts`，参考 `deploy` |
| 新增 CLI 渲染/共享辅助 | 多命令共用的渲染放 `src/cli/render/`（下载类事件走 `render/download.ts`，不要各写进度与 ↓/=/✗）；参数解析放 `src/cli/shared/args.ts`，Java/账号用例放 `src/cli/use-cases/`；输出统一走 `src/cli/output/`（ansi/stream/progress），Operation 消费走 `src/cli/consume/`；不要反向 import `src/cli/index.ts` / `src/cli/registry.ts`（`src/cli/architecture.test.ts`） |
| 新增事件码 | `src/core/events/<域>.ts` 的载荷接口（按 auth/assets/deploy/launch… 分域），再到 `src/core/events/payloads.ts` 合并；`LogCode` 由 key 自动派生，消费者按 `ev.code` 收窄。新增码后 typecheck 会指出所有需要处理的 switch |
| 新增 Finding | `src/core/preflight/types.ts` 的 `FINDING_CODES`、`docs/finding-codes.md`（`codes.test.ts` 双向校验）、产生它的 checker |
| 新增加载器 | `src/core/sources/<loader>.ts`、`src/core/setup/<loader>.ts`（adapter，返回 `LoaderInstallResult`）、`src/core/setup/loader-types.ts`（共享类型）、`src/core/setup/loader.ts` 的 `LOADERS` 表、profile 型加载器复用 `src/core/setup/profile.ts`、CLI 命令、`src/index.ts` 公共导出 |
| 整合包读取（mrpack / CurseForge） | `src/core/pack/`：`index.ts` 的 `readPackFile`、`mrpack.ts`、`curseforge.ts`、`overrides.ts`；下载任务构建与 overrides 解压仍在 `src/core/setup/pack.ts`。preflight 与 deploy 都走 `readPackFile`，不要各自判格式 |
| 修改 deploy 步骤 / 部署后自检 | `src/core/deploy/index.ts` 只排顺序；本地包 / Modrinth slug 的获取放 `pack-source.ts`，整合包→下载任务放 `source-tasks.ts`，自检与 lock 放 `post-check.ts`，步骤事件转发用 `src/core/operations/forward.ts`；参数/结果形状改 `types.ts` |
| 实例状态 / lock | `src/core/instance/lock.ts`（schema、读写、verify）、`update.ts`、`loader-update.ts`；schema 变更先改 ADR-0041 |
| 实例配置 | `src/core/instance/config.ts`、`src/cli/commands/config.ts`、`run`/`launch`/`deploy` 的读取点 |
| 诊断输入 | `src/core/diagnostics/index.ts`；格式解析放 `crash.ts` / `hs-err.ts` / `crash-report.ts`，证据发现放 `artifacts.ts` |
| 预检规则 | `src/core/preflight/`：`check.ts`（Java/内存）、`local.ts`（本地依赖/重复/加载器/breaks）、`assets.ts`、`closure-findings.ts`（依赖闭包 → Finding）、`report.ts`（checker 集合、stats 与 verdict 只在这） |
| 模组元数据格式 | `src/core/modmeta/read.ts`（候选顺序、jar-in-jar、损坏判定）+ `parsers.ts` 注册表；每种格式一个解析器：`fabric.ts`、`quilt.ts`、`mcmod.ts`、`forge-toml.ts`，共享的 JSON 宽松解析与依赖归一化在 `json.ts` / `deps.ts` |
| 实例身份 | `src/core/instance/identity.ts`（`mmc-pack.json` 的读写、Loader↔uid 表）、`scan.ts` 的读取点、`setup/*` 的写入点 |
| 新增 E2E | `scripts/e2e.ts` + `docs/testing/real-tests.md`（`scripts/real-tests.test.ts` 校验集合一致） |
| 新增公共 API | `src/index.ts` + `scripts/entry-smoke.mjs` 的必需导出列表；`npm run build && npm run smoke:entry` |
| 内容源装配 | `src/assembly.ts` 的 `createContentSources`：CLI 与 MCP 都从这里拿 Modrinth / CurseForge 实现；不要在命令或 MCP 里直接 new。`--china` / `--no-cf-mirror` 的解释也只在这里 |

## 不变量

- **core 不依赖外层**：`src/core/` 不能 import `src/sources/`、`src/cli/`、`src/mcp/`
  （`src/core/architecture.test.ts`）。
- **core 分层与环**：`src/core/architecture.test.ts` 的 `MODULE_LAYERS` 是唯一分层表，
  新增模块必须先登记层级。已知的反向依赖与循环记在 `KNOWN_*` 基线里，只能减少；
  修掉一条就同步删掉对应基线。
- **core 不直接输出**：不能 `console.*`、`process.stdout/stderr`；所有状态变化先成为
  `OpEvent`（同上测试 + Biome `noConsole`）。
- **CLI 依赖方向**：`render/` 只依赖 `output/` 与 core 类型；`output/` 不依赖渲染与
  消费器；`command/` 不依赖具体命令；`commands/` 不反向 import 入口与注册表；
  文件与目录之间没有循环（`src/cli/architecture.test.ts`）。
- **命令只做声明与渲染**：命令文件只能值 import `command/`、`shared/`、`use-cases/`、
  `render/`、`output/`、`consume/`；对 core 的**值**依赖只允许基线里的历史项，
  新流程先进 `use-cases/`。基线只减不增。
- **use-cases 不写输出**：不 import `output/` / `render/`，不直接写 stdout/stderr
  （`src/cli/architecture.test.ts`）。Java / 账号用例返回结构化结果，由 `render/java.ts`、
  `render/auth.ts` 渲染。
- **纯工具白名单**：`core/errors.ts`、`core/hints.ts`、`core/redact.ts` 可以被命令与
  render 直接值 import；其余 core 值依赖必须走 use-cases 或记入基线。
- **入口只做守卫**：`src/cli/index.ts` 不写业务；分发在 `main.ts`，命令清单只在
  `registry.ts`。测试取命令集合从 `registry.ts` 取，不 import 入口。
- **内容源装配只有一处**：CLI 与 MCP 都走 `src/assembly.ts` 的 `createContentSources`；
  两个入口对 `--china` / `--no-cf-mirror` 的解释不会各写一份。
- **加载器分派只有一处**：`src/core/setup/loader.ts` 的 `LOADERS` 表；deploy 与 CLI
  都走 `createLoaderInstall`，`loaderNeedsJava` 也从这张表派生。不要在消费方再写
  `kind === 'forge' || …`。
- **报告装配只有一处**：`src/core/preflight/report.ts` 的 `preflightFrom`——checker 集合、
  `stats` 与 `verdict` 都只在这。目录预检、包预检、deploy 自检都从这里出结论；
  不要按来源各挑一遍 checker。
- **deploy 编排与步骤分离**：`src/core/deploy/index.ts` 只负责参数归一、CurseForge
  解析、五步顺序与结果装配；任务构建在 `source-tasks.ts`，自检/lock 在 `post-check.ts`。
  新增步骤先放进独立 module，不要直接塞回 index。
- **事件码按域登记**：先在 `src/core/events/<域>.ts` 声明载荷，再在
  `payloads.ts` 合并；`LogCode` 由 key 自动派生。`Finding.code` 用联合类型，
  新增码必须进 `FINDING_CODES` 与文档。
- **lock 是磁盘事实**：`<实例>/.blockpilot/lock.json`；`verify` 只信 lock 与磁盘，不联网。
- **重跑安全**：deploy 默认不覆盖已有 overrides；update 先下载校验再删旧文件。
- **串联命令用 `consumeValue`**：run / install 这类多 Operation 命令，中间步骤走
  `consumeValue(..., { exitEvent: false })`（`src/cli/consume/index.ts`）拿 result；
  不要直接 `consume` 再手写 `result`/`capture`——事件模式下忘记捕获会静默返回 1。
- **退出码只算一次**：`OpUi.exitCode` 必填，`result` 只负责渲染；普通模式与
  `--events` 共用同一个退出码，漏写一边会变成 typecheck 错误。

## 常用检查

```bash
npm run lint        # Biome：格式 + lint
npm run typecheck   # 源码 + scripts
npm test            # 单测（含 core/cli 架构守卫、文档/码表/入口同步）
npm run check       # lint + typecheck + test
npm run e2e -- --tier 0
```
