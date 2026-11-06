# 0028. `install` 的退出码只对「装」负责

- **Status**: Accepted
- **Date**: 2026-11-06
- **Deciders**: @liming
- **Depends on**: ADR-0002、ADR-0014

## Context

`install` 先跑一遍预检，再按 `plan.installs` 补装缺失依赖。它的退出码原本是
`return verdictExit(report.verdict)`（`src/cli/index.ts:420`），也就是**继承预检结论**。

于是出现两个说不通的结果：

1. 机器没有 Java → 预检 `BLOCKED`（`JAVA_MISSING`）→ 即使「没有需要补装的依赖」也退 2。
   `install` 明明把事情做对了（确实没有要补的），却返回「有问题」。
2. 在 CI 上更明显：一个只负责补模组的步骤，因为 runner 没装 Java 而变红。
   2026-11-06 的实测里，`E2E-106` 就是这么红的，当时的处理是给用例加 `--no-host` 绕开——
   等于用测试迁就了一个含糊的契约。

根因是两个问题被塞进了一个数字：**「这个包能不能跑」**（preflight 的职责）
与**「这次补装成不成功」**（install 的职责）。前者由宿主机、游戏版本、模组兼容性共同决定，
后者只与下载有关。

同一批数据里还有一个反面证据：`install --dry-run` 在「有计划」时返回 0，
在「没计划」时返回预检结论——同一个命令的退出码含义取决于有没有东西可装。

## Decision

1. `install` 的退出码只反映安装结果：
   - `0`：没有需要补装的依赖，或全部装好；
   - `2`：有文件下载失败（沿用现有 installer 的约定）；
   - `1`：参数或环境错误。
2. 预检结论照旧完整打印（findings / plan 都在），但**不进入退出码**。
   当结论是 `blocked` / `unknown` 时补一行说明：
   「预检结论 blocked 说的是「这包能不能跑」，不影响本命令的退出码。」
3. 需要按预检判定拦截的脚本，用 `preflight --json` 读 `verdict`，不要拿 `install` 的退出码代偿。
   README 的脚本章节写明这个例外。

## Consequences

**Positive**

- 两个问题各自有一个明确的信号源，不再互相污染。
- CI 可以单独跑「补模组」这一步，不需要在 runner 上装 Java。
- `--dry-run` 有计划和没计划时的退出码终于一致。

**Negative**

- 依赖 `install` 退出码拦截问题的脚本会从 2 变成 0。这是有意的语义修正，
  但属于退出码变化，需要在 CHANGELOG / README 里说清楚。
- 用户看到屏幕上写着 `BLOCKED`、退出码却是 0，可能疑惑——用上面那行说明缓解。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 保持继承，只在文档里写清楚 | 「补装依赖」这个动作本身没有失败，退 2 就是在说谎；文档救不了脚本 |
| 只把宿主类 finding（JAVA_MISSING / JAVA_NEWER_ONLY）排除 | 退出码仍然一半代表安装、一半代表模组兼容性，两件事继续混着。要拦模组问题应该看 preflight |
| 新增退出码 3 表示「装完了但预检 blocked」 | 多一个状态就多一套消费逻辑；而且这个状态用 `preflight --json` 已经能表达 |

## 验证

- 真包：`fixtures/fo-6.5.0.mrpack` + 本机无 Java → 预检 `BLOCKED`，`install --dry-run` 退出码 0，
  输出含那行说明。
- `E2E-106` 改回不带 `--no-host`：没 Java 的机器上仍须退 0，同时钉住「未验证依赖默认不装」。
- 回归：`npm test` 289 条、`npm run e2e` T0 15/15、T1 7/7。
