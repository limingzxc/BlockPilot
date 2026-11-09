# 0038. 每条子命令只声明一次

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Depends on**: ADR-0001, ADR-0023

## Context

`cli/index.ts` 被近 40 次提交里的 18 次触碰，是仓库最热的一个文件。一条子命令的
interface 同时写在三个地方，彼此之间没有任何同步机制：

| 位置 | 内容 | 规模 |
|---|---|---|
| `flags.ts` 的 `COMMAND_FLAGS` | 每条命令接受哪些 flag | 20 行表 |
| `usage()` | 同一批 flag 的手写帮助 | 67 行文本 |
| 每个 handler | `argOf` 取值、`argv.includes` 判开关 | 40 + 23 次 |

代价不是假设。`usage()` 里写着「CF 包只能预检版本与 Java；mod 级校验要 API key」，
而 ADR-0036 与 README 都改成免 key 能做 mod 级校验了——改的是 core，帮助文本没人动。

此外每个 handler 自己拼一遍 `root / instance / layout / china / sources / signal`：
8 处逐字重复，`createInterrupt().signal` 出现 13 次，`--proxy` 走一个模块级可变全局。

## Decision

**一处声明，三处派生。**

### `flags.ts` —— flag 的形状

`FlagSpec`：`takesValue`、取值占位符 `value`、`help`、`common`、`required`。
布尔开关可以用字符串简写（`'--json': '输出结构化报告'`），否则二十多个开关
每个写三行对象，声明区就没法扫读（`FlagDecl` + `normalizeFlags`）。

`validateFlags` 同时接管必填检查：`install` 不带 `--mods-dir` 在校验层就报
「缺少必填参数」，不再进 handler 打印整篇帮助。

### `commands.ts` —— 声明、上下文、帮助渲染

- `defineCommand(spec)`：校验 flag 形状（要取值就必须有占位符、每个 flag 必须有 help），
  **写错在 import 阶段就炸**。每条测试都会经过这里，不会等到用户敲 `--help` 才发现。
- `CommandContext`：`argv / signal / proxy / root / instance / layout / sources / china`
  加 `has()` / `value()`。`layout` 与 `sources` 惰性求值——`preflight` / `install`
  只认一个路径，不该因为「默认根目录恰好是个文件」而在解析布局这一步失败。
- `usageText()`：用法行、通用 flag、每条命令的说明与自己的 flag，全部从声明派生。
  `--root` / `--instance` 标 `common`，只解释一次。

### `index.ts` —— 声明紧挨 handler

15 个 `defineCommand({...})` 各自贴在它的 handler 上面；`main()` 只剩
「找命令 → 校验 → 建上下文 → 跑」。`--help` 集中处理，`blockpilot <cmd> --help`
从退出码 1 改成 0。

`main()` 的启动改成入口判断（`import.meta.url === pathToFileURL(process.argv[1]).href`）：
`hints.test.ts` 要 import 这个文件取 `COMMANDS`，让那次 import 变成一次真实的
命令行执行显然不对。入口路径不变，`bin` 仍是 `dist/cli/index.js`。

顺带两处归位：

- `pickSources` 从 `setup/vanilla.ts` 搬到 `download/sources.ts`——它只是在
  `chinaFirstSources()` 与 `defaultSources()` 之间选一个，家应该在它俩旁边。
- `takeProxyArg` 少写值时抛 `UsageError` 而不是内部 `process.exit(1)`，让顶层
  错误映射统一处理。

## Consequences

**Positive**

- 加一个 flag 只改一处；帮助与校验不可能再对不上
- 新增子命令的成本 = 一段声明 + 一个 handler，不再抄 5 行 preamble
- `hints.test.ts` 现在拿真实的声明校验提示里的命令，而不是另一份表
- `--proxy` 不再是模块级可变状态，测试可以独立构造上下文

**Negative**

- CLI 总行数 1806 → 2149。增量几乎全是声明数据与帮助渲染，不是重复逻辑；
  换来的是三份声明变一份
- `index.ts` 仍是 1800 行的单文件。声明和 handler 挨着放解决了「一处声明」，
  没解决「一个文件装 15 条命令」
- 形状写错会在 import 阶段抛异常，而不是给一条友好的错误——这是有意的：
  它是编程错误，该在 CI 里炸

## 不做

- **不把 `index.ts` 拆成每命令一个文件**：值得做，但和「一处声明」正交。
  先让声明站住，拆文件随时可以后做。
- **不给 MCP 复用这套声明**：ADR-0001 的边界仍然成立——两个 consumer 的输出
  形态不同，共享声明会让两边互相迁就。
