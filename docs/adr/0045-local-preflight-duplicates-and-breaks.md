# 0045. 本地预检补齐重复 / 加载器 / breaks

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0025（依赖闭包）、ADR-0026（本地检查）

## Context

`checkLocalInstance` 只做了三件事：依赖缺失/版本、损坏 jar、无元数据。
三类**确定性失败**没有覆盖：

1. **重复 modId**：同一模组的两个 jar 都在 `mods/` 里。Fabric/Forge 在加载阶段
   直接拒绝，预检却给 `ok`。
2. **加载器不匹配**：Fabric 实例里放了 Forge 模组。它不会「部分工作」，而是
   加载阶段就失败。
3. **breaks / incompatible**：A 声明「不能和 B 一起装」，B 也在实例里。旧解析器
   把 `breaks` 直接丢掉，冲突完全不可见。

## Decision

在 `checkLocalInstance` 里补三条：

- `DUPLICATE_MOD`（blocker）：按 `depKey(modId)` 分组，>1 份 jar 就报，hint 列出文件。
- `LOADER_MISMATCH`（warning）：`meta.loader` 与 `instance.loader.kind` 不同就报。
  Quilt 实例允许 Fabric 模组（Quilt 兼容 Fabric）；其余只认同名加载器。
  `unknown` 跳过，避免把读不出 loader 的 jar 误报。
- `DECLARED_INCOMPATIBLE`（blocker）：解析 Fabric `breaks`、NeoForge
  `type = "incompatible"` 为 `ModDependency.kind = 'breaks'`；双方都在实例里才报。
  带 `versionRange` 时只在 `satisfiesRange` 明确 `satisfied` 时报，范围看不懂或
  版本缺失就不报——宁可漏报，也不制造假 blocker。

`ModDependency` 新增可选 `kind?: 'depends' | 'breaks'`，缺省仍是 `depends`。
`checkLocalDeps` 只看 `mandatory`，因此 breaks 不会触发「缺依赖」。

## Consequences

**Positive**

- 重复 jar、装错加载器、明确互斥这三类启动必崩的问题，在预检阶段就能看到。
- breaks 的版本范围被尊重，不会把「A 只与 B <1.0 冲突」误报成「A 与 B 冲突」。

**Negative**

- `LOADER_MISMATCH` 是 warning：Sinytra Connector 这类兼容层会让 Forge 模组
  在 Fabric 上工作，此时会多一条提示。
- NeoForge 1.20.1 能加载部分 Forge 模组，也会被提示；级别是 warning，不拦启动。
- 重复 modId 只覆盖顶层 jar；jar-in-jar 里的同名副本仍按原有「顶层优先」规则处理。

## 验证

- `src/core/preflight/local.test.ts`：
  - 两份 `dup` jar → `DUPLICATE_MOD` blocker
  - Fabric 实例里的 Forge 模组 → `LOADER_MISMATCH` warning
  - A `breaks: { b: '*' }` + B → `DECLARED_INCOMPATIBLE` blocker
- `src/core/modmeta/read.test.ts`：Fabric `breaks` 与 NeoForge `incompatible` 的解析
- `src/core/preflight/codes.test.ts`：`DUPLICATE_MOD` 已登记进码表
