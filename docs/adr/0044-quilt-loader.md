# 0044. Quilt 加载器支持

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0035（Legacy Fabric）、ADR-0040（加载器边界）

## Context

`LoaderKind` 里一直有 `quilt`，`scan` 也认 `org.quiltmc.quilt-loader`，
但 `deploy` 的 `supported` 只列了 Fabric / Forge / NeoForge，CLI 也没有 `quilt`
命令。结果是 Quilt 整合包能通过预检（版本/加载器字段对得上），到 deploy 才报
`UNSUPPORTED_LOADER`。

Quilt 的元数据与 Fabric 同形：

- 列表：`GET https://meta.quiltmc.org/v3/versions/loader/<mc>` →
  `[{ loader: { version } }]`
- profile：`GET .../<mc>/<loader>/profile/json` → 与 FabricProfile 相同的
  `id/inheritsFrom/mainClass/libraries/arguments`

两个差异：

1. 没有 `stable` 标志，也不能拿 `list[0]` 当最新——实测 1.20.1 的 310 条里
   0.20.0-beta.9 排在 0.29.2-beta.4 前面。
2. profile 的 `arguments` 可能只有 `game`，没有 `jvm`（jvm 参数从父版本继承）。

## Decision

- 新增 `core/sources/quilt.ts`：三态 `listQuiltLoaders` / `fetchQuiltProfile`，
  `pickQuiltLoaderVersion` 按版本号取最大，不依赖列表顺序。
- 新增 `core/setup/quilt.ts`：复用 `buildFabricTasks`（只依赖 profile 的
  `libraries` 形状），写版本 JSON 与 `mmc-pack.json`，下载 loader 库与原生库。
- `deploy` 的 `SUPPORTED_LOADERS` 加 `quilt`，loader 步骤分派到 `createQuiltSetup`。
- 新增 CLI `quilt <mc>`（`--loader` 可指定版本）。
- `FabricProfile.arguments.jvm` 改为可选，容纳 Quilt 的 profile 形状。

## Consequences

**Positive**

- Quilt 包不再在 deploy 阶段被拒绝。
- 版本选择不依赖服务端排序，不会装到一个旧 beta。

**Negative**

- 没有真实 Quilt 实例的端到端测试；目前只有元数据形状与版本选择的单测。
  profile 里的 maven 库仍从 `maven.fabricmc.net` / `maven.quiltmc.org` 取，
  国内网络下可能比 Fabric 更慢。
- Quilt 的 `quilt-loader` 版本语义与 Fabric 不同，`--loader` 由用户显式给时
  不做兼容性校验。

## 验证

- `src/core/sources/quilt.test.ts`：版本取最大、列表解析、404/断网三态
- `src/core/deploy.test.ts`：Quilt 在 `SUPPORTED_LOADERS` 里，不再报
  `UNSUPPORTED_LOADER`
- 真机验证仍待补：`blockpilot quilt 1.20.1` 后 `run` 能进游戏
