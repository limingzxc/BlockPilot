# 0047. 加载器不匹配不再判死整包

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0025（缺依赖只报 warning）、ADR-0045（本地预检的加载器检查）、issue #17

## Context

同一个 304 mod 的 Forge 包（落幕曲 1.6.8），两个入口给出两套互相矛盾的结论：

- 对 zip 预检：`LOADER_MISMATCH` 判 **blocker**，整包 BLOCKED——两个 Fabric 专用 jar
  被说成「不支持 forge 加载器」。
- 对解压后的实例预检：同一批 jar 被读成 Fabric 元数据，于是
  `satisfying_buttons 需要前置 fabric-api`、`collective 需要前置 fabric` 一串假缺依赖。

实测这个包 306 个模组全部加载、跑满 211 秒正常退出：被「判死」的那两个 jar
根本没参与加载——Forge 遇到没有 `mods.toml` 的 jar 是**跳过**，不是崩溃。

两处判断都错了，而且错在相反的方向：一处把「会被忽略」说成「装不上」，
另一处把「不会被加载的 jar 的依赖」算成「缺失」。

## Decision

1. **`readModMetadata` 接收实例加载器**（`opts.loader`），候选元数据按它排序：
   Forge 实例先读 `mods.toml` / `neoforge.mods.toml`，Fabric 实例先读 `fabric.mod.json`。
   多加载器 jar（`Towns-and-Towers-1.12-Fabric+Forge.jar`）因此不会在 Forge 实例里
   凭空多出 `fabric-api` 依赖。`scanInstanceDir` 把 `loader.kind` 传进去。
2. **加载器不匹配的 jar 单独归类**：`checkLocalInstance` 把它们从依赖检查、
   重复检查、`breaks` 检查里摘出去，只留一条聚合的 `LOADER_MISMATCH` warning
   （列出 modId 与文件），提示「加载器会直接跳过它们，它们声明的依赖也不参与检查」。
3. **`LOADER_MISMATCH` 从 blocker 降为 warning**（在线链路的 `checkInstance` 同样），
   理由与 ADR-0025 一致：拦不住的东西不该拦，用户需要的是知情而不是 BLOCKED。

`vanilla` 实例不报这条（没有加载器就无从判断），`loader: 'unknown'` 的 jar
照旧参与检查——读不出加载器不等于不匹配。

## Consequences

**Positive**

- 包里混进几个装错的 jar 不再让整个包白装一次。
- 实例预检不再输出「装了 Forge 却缺 fabric-api」这类无从修的建议。
- 两个入口对同一批 jar 给出一致的说法。

**Negative**

- 真正的「加载器装错了」变安静了：只有 warning，退出码仍是 0。用户不看输出就会
  带着几个不加载的 jar 玩——但它们本来也不会加载，不影响启动。
- 依赖检查只覆盖会被加载的 jar；如果某个 Fabric 模组的依赖恰好只由另一个
  Fabric jar 提供，两者一起被摘掉，不会互相报缺（这是想要的行为，但覆盖面变窄）。

## Alternatives

- **保留 blocker，只修元数据选择**：元数据修好之后 zip 预检仍会把纯 Fabric jar 判死，
  与实测不符（游戏能跑），放弃。
- **逐 jar 一条 warning**：304 mod 的包里两条还行，但一个包里混十几个时输出会被刷屏，
  且每条都在重复同一句「会被忽略」。聚合成一条，细节放 `data.files`。

## 验证

- `src/core/modmeta/read.test.ts`：同一个双加载器 jar，`loader: 'forge'` 读 `mods.toml`、
  `loader: 'fabric'` 读 `fabric.mod.json`
- `src/core/preflight/local.test.ts`：Forge 实例里的 Fabric 专用 jar → 无
  `MISSING_DEPENDENCY`，只有一条 `LOADER_MISMATCH` warning，`data.mods` 列出该 jar
- `src/core/preflight/check.test.ts`：`LOADER_MISMATCH` 的 severity 是 warning
- `docs/finding-codes.md`：级别一列同步改成 warning
