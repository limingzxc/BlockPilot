# 0037. 预检报告只有一个装配器

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Depends on**: ADR-0002, ADR-0023, ADR-0033

## Context

`PreflightReport` 有两个装配点：`preflight/index.ts` 与 `deploy.ts` 的「部署后自检」。
三个 checker（`checkJava` / `checkLocalInstance` / `checkAssets`）是共享的，**装配不是**。

两份装配的差异不是风格问题，是结论问题：

| 规则 | preflight | deploy 自检 |
|---|---|---|
| `checkJava` | 有 | **结构上不可能有**——`DeployOptions` 里没有 `host` 字段 |
| `unresolved > 0` 则 `ok` 降为 `unknown` | 有 | 无 |
| `stats` 三计数 | 有 | 无 |

后果是可复现的：装完打「部署后检查 通过」，紧接着 `run` 因为 `JAVA_TOO_NEW`（1.12 及更早
只能用 Java 8）或 `JAVA_MISSING`（26.x 要 Java 25）死掉。同一个实例、同一分钟、同一台机器。
这不是推测，`docs/testing/2026-11-06-real-user.md:294` 早就记了这个现象：
「预检说 BLOCKED 的包能装、能跑；部署后检查说 OK 的包起不来」。

ADR-0023 候选 5 修的是「测试不穿过 Operation interface」；这次的病是同一个——
deploy 的自检**绕过 interface 手抄了一遍装配**，所以它抄漏的东西没有任何测试会红。

## Decision

新增 `src/core/preflight/report.ts`，把「折成一个结论」收成一份：

- `assembleReport({ findings, stats, target, plan })` → `PreflightReport`。
  `verdict` 的 `unknown` 规则、`plan` 的缺省只在这里。
- `preflightDir({ dir, scan, host?, assetsDir? })` → 完整报告。
  串起三个 checker，`stats` 也只有一处算法。
- `javaRequirements` 从 `index.ts` 搬进来——它是「这个目录的 Java 要求」的一部分。

调用方：

- `createPreflight` 的目录分支**提前返回**，整个报告由 `preflightDir` 产出；
  整合包的两个分支（CF / 在线）保留各自的元数据逻辑，只共用 `assembleReport`。
- `createDeploy` 的自检改成 `preflightDir({ dir: gameDir, scan, assetsDir: layout.assets, host })`。
- `DeployOptions` 新增 `host?: HostProfile`，CLI 在 `deploy` 里调 `detectHost()`。
  检测要起若干次 JVM 进程（1–3 秒），相比几分钟的下载可以忽略。
- `DeployResult.check` 新增 `stats`：CLI 在 `unknown` 时说明「N 个文件没参与检查」，
  不能让 `UNKNOWN` 跟着一句「没有发现阻塞项」一起出现。
- `EMPTY_PLAN` 移到 `deps/plan.ts`——它拥有 `RepairPlan`，不该有两个副本。

## Consequences

**Positive**

- deploy 自检与 `preflight <实例目录>` 现在是同一条代码路径，结论不可能再分叉
- `preflight/index.ts` 349 → 318 行，目录模式从「扫 + 三查 + 装配」变成一次 `preflightDir`
- `assembleReport` 有 4 条 interface 测试，deploy 有 2 条回归测试（Java 缺失判 blocked、
  unresolved 判 unknown 且与 preflight 同结论）
- 新增一条 `deploy.check` 的 `unresolved` 日志字段：结论不可信时，原因也在事件里

**Negative**

- `deploy` 多花 1–3 秒在 Java 检测上
- `DeployResult.check` 多一个字段。deploy 没有 `--json`，MCP 也不暴露 deploy，
  所以没有外部契约被破坏

## 不做

- **不给 `deploy` 加 `--no-host`**：preflight 加这个开关是为了省掉短暂命令的 1–3 秒；
  deploy 加它只会给「自检假通过」留一个后门，而它正是这次要堵的洞。
- **不改 MCP 的 preflight**：它至今不传 `host`，所以那份报告没有 Java 结论。
  这是一个独立的缺口（MCP 没有「本机」的语义），不在本次范围内。
