# 架构与改动落点

改代码前先看这张表：每类改动都有固定的几个落点，漏一个通常不会立刻报错，但会在下一次
`verify` / `update` / 消费端暴露。路径都相对仓库根。

## 改动落点

| 要改什么 | 必须一起改的地方 |
|---|---|
| 新增/修改 CLI 命令 | `src/cli/commands/<name>.ts`（`defineCommand` + handler）、`src/cli/common-flags.ts`（共享 flag）、`src/cli/index.ts` 的 `COMMANDS` 汇总、`src/cli/commands.ts`（flag/usage 类型）、`README.md` 命令表（`src/cli/readme.test.ts` 会校验） |
| 新增 CLI 渲染/共享辅助 | 多命令共用的渲染放 `src/cli/render/`；参数解析、Java/账号选择放 `src/cli/shared.ts`；不要反向 import `src/cli/index.ts` |
| 新增事件码 | `src/core/events.ts` 的 `LogCode` 与 `LogPayloads`；消费者按 `ev.code` 收窄。新增码后 typecheck 会指出所有需要处理的 switch |
| 新增 Finding | `src/core/preflight/types.ts` 的 `FINDING_CODES`、`docs/finding-codes.md`（`codes.test.ts` 双向校验）、产生它的 checker |
| 新增加载器 | `src/core/sources/<loader>.ts`、`src/core/setup/<loader>.ts`、`src/core/deploy.ts` 的 `SUPPORTED_LOADERS` 与 loader 分派、CLI 命令、`src/index.ts` 公共导出 |
| 实例状态 / lock | `src/core/instance/lock.ts`（schema、读写、verify）、`update.ts`、`loader-update.ts`；schema 变更先改 ADR-0041 |
| 实例配置 | `src/core/instance/config.ts`、`src/cli/index.ts` 的 `config` 命令、`run`/`launch`/`deploy` 的读取点 |
| 诊断输入 | `src/core/diagnostics/index.ts`；格式解析放 `crash.ts` / `hs-err.ts` / `crash-report.ts`，证据发现放 `artifacts.ts` |
| 预检规则 | `src/core/preflight/`：`check.ts`（Java/内存）、`local.ts`（本地依赖/重复/加载器/breaks）、`assets.ts`、`report.ts`（verdict 只在这） |
| 新增 E2E | `scripts/e2e.ts` + `docs/testing/real-tests.md`（`scripts/real-tests.test.ts` 校验集合一致） |
| 新增公共 API | `src/index.ts` + `scripts/entry-smoke.mjs` 的必需导出列表；`npm run build && npm run smoke:entry` |

## 不变量

- **core 不依赖外层**：`src/core/` 不能 import `src/sources/`、`src/cli/`、`src/mcp/`
  （`src/core/architecture.test.ts`）。
- **core 不直接输出**：不能 `console.*`、`process.stdout/stderr`；所有状态变化先成为
  `OpEvent`（同上测试 + Biome `noConsole`）。
- **verdict 只有一份实现**：`src/core/preflight/report.ts`；deploy 自检也调它，不要手抄。
- **事件码成对**：`LogCode` 与 `LogPayloads` 必须同时登记；`Finding.code` 用联合类型，
  新增码必须进 `FINDING_CODES` 与文档。
- **lock 是磁盘事实**：`<实例>/.blockpilot/lock.json`；`verify` 只信 lock 与磁盘，不联网。
- **重跑安全**：deploy 默认不覆盖已有 overrides；update 先下载校验再删旧文件。
- **串联命令用 `consumeValue`**：run / install 这类多 Operation 命令，中间步骤走
  `consumeValue(..., { exitEvent: false })` 拿 result；不要直接 `consume` 再手写
  `result`/`capture`——事件模式下忘记捕获会静默返回 1。
- **退出码只算一次**：`OpUi.exitCode` 必填，`result` 只负责渲染；普通模式与
  `--events` 共用同一个退出码，漏写一边会变成 typecheck 错误。

## 常用检查

```bash
npm run lint        # Biome：格式 + lint
npm run typecheck   # 源码 + scripts
npm test            # 单测（含文档/码表/入口同步）
npm run check       # lint + typecheck + test
npm run e2e -- --tier 0
```
