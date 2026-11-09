# 0042. 诊断把 hs_err 与 crash-report 当成一等输入

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0002（诊断只报有证据的结论）、ADR-0040（本次边界）

## Context

`diag` 此前只接受「会话日志」：`logs/<时间戳>.log` 或用户显式 `--file`。
但真实世界里最常见的两种崩溃证据不在那里：

- **JVM 原生崩溃**：`hs_err_pid*.log` 写在实例根目录。没有 Java 异常栈，
  只有信号、问题帧、寄存器。用普通日志规则去扫，最多命中一个 `OutOfMemoryError`，
  其余被当成「没有异常」——用户拿到 `verdict=clean`，而 JVM 刚刚整个死了。
- **Minecraft 崩溃报告**：`crash-reports/crash-*.txt`。它有 `Description:` 与
  `-- System Details --`，普通日志扫描只能看到其中的栈，丢掉摘要。

这不是「少一个功能」，是**结论错误**：最严重的崩溃被报成 clean。

## Decision

### 1. 格式识别先于分析

`detectFormat(text)` 只看头部：

- `# A fatal error has been detected by the Java Runtime Environment` → `hs-err`
- `---- Minecraft Crash Report ----` → `crash-report`
- 其余 → `log`

`DiagResult.format` 把这个判断暴露给消费者（CLI / MCP / 脚本）。

### 2. hs_err 有独立分析器

`analyzeHsErr` 只做有证据的三件事：

- 取 `EXCEPTION_*` / `SIG*` 信号与 `Problematic frame` 的下一行
- 分类：`OutOfMemoryError` → `out-of-memory`；问题帧命中显卡/LWJGL 库 →
  `graphics`；其余原生崩溃 → `natives`；没有可用帧 → `unknown`
- 给出对应 hint（更新驱动 / 降堆 / 贴前 80 行）

`parseHsErrFrames` 把 `Java frames:` 段的 `j  com.foo.Bar.baz(...)V+8`
转成 `StackFrame`，交给现有归属逻辑。它拿不到源码位置与来源 jar，
归属只能靠包名匹配——这比「不归属」好，但不能声称是强证据。

### 3. 发现三类证据，按 mtime 选最新

`findCrashArtifacts(gameDir)` 汇总：

- `<gameDir>/hs_err_pid*.log`
- `<gameDir>/crash-reports/crash-*.txt`
- `<gameDir>/logs/*.log`（排除 `debug.log`）

按修改时间倒序。`diag` 未显式给 `--file` 时取最新的一份；选中非普通日志时
在 stderr 说明「使用 JVM 崩溃报告 / Minecraft 崩溃报告」，不让用户误以为
在读 latest.log。

## Consequences

**Positive**

- JVM 原生崩溃不再被报成 clean。
- `crash-reports/` 与 hs_err 不需要用户手工找路径。
- `format` 让 MCP/脚本能区分「这是日志」还是「这是 JVM 尸检」。

**Negative**

- 原生崩溃的归属只能靠包名，证据强度低于 Java 栈；`culprits` 仍可能为空。
- 最新文件不一定是最相关文件（例如旧的 hs_err 比今天的日志新）；用户可用
  `--file` 覆盖。
- 没有真实 hs_err 样本库，规则基于公开格式；后续应补 `testdata/` 样本与黄金用例。

## 验证

- `src/core/diagnostics/hs-err.test.ts`：格式识别、显卡/原生/内存分类、
  Java frames 转换、非 hs_err 不产结论
- `src/core/diagnostics/artifacts.test.ts`：三类排序、`debug.log` 排除、空目录
- `scripts/e2e.ts` E2E-016：只有 hs_err 时 `diag --json` → 2、`format=hs-err`、
  `primary.kind=graphics`

## 不做

- **不解析 `-- System Details --` 的模组清单**：crash-report 的栈已经能归属，
  再读一遍清单只会引入新的解析失败面。
- **不把 hs_err 的寄存器/内存映射做成结论**：那些字段对「哪个模组」没有证据价值。
- **不在 `run` 里自动检测 hs_err**：诊断仍是用户显式发起的只读操作。
