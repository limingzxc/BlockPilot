# 0032. CF 没有 key 时降级安装；overrides 里的模组单独统计

- **Status**: Accepted
- **Date**: 2026-11-08
- **Deciders**: @liming
- **Related**: ADR-0021、ADR-0029

## Context

ADR-0021 把「没 key 只能查不能装」定为边界，实现上是 `deploy` 直接
`CF_API_REQUIRED` + exit 1。真机装了落幕曲 1.6.8（271 个 fileID、5947 个
overrides 文件、其中 `overrides/mods/` 有 33 个 jar）之后，这条边界的代价很清楚：

- 拒绝发生在**所有事情之前**——原版、加载器、overrides 全都没做。用户想装这个包，
  只能自己解压 zip、手工跑 Forge installer、再补 `setup`（否则 natives 缺失，
  启动报 `UnsatisfiedLinkError: lwjgl.dll`）。
- 提示写着「到 console.curseforge.com 申请 key」，但当时仓库里没有任何地方读 key。
  用户申请完也填不进去，等于一条死路（key 支持见 ADR-0029，提示已改为环境变量名）。
- 统计也对不上：`preflight` 说 271 个模组，解压后 `mods/` 有 304 个 jar，
  日志里是 `Loading 306 mods`。那 33 个是打包者塞进 overrides 的，
  本来就不需要 key。

## Decision

1. **没有 key 时降级，不拒绝**：原版 → 加载器 → overrides 照常执行；清单里的文件
   进 `failed`，每条的原因直说「没有 BLOCKPILOT_CF_API_KEY」（不是「可能已下架」——
   后者会把用户引去网页逐个核对 271 个文件）。退出码 2，与「有文件没装上」一致。
2. `deploy.cf_no_key` 事件带上文件数，CLI 打印成醒目的提示 + 配置方法；
   配好 key 重跑同一条命令时，已下的文件走缓存跳过。
3. `overrides/mods/*.jar` 单独计数（`countOverridesMods`，只读中央目录、不解压），
   在三处体现：`preflight` 出 `PACK_BUILTIN_MODS`（info）、`deploy` 结果里
   `overridesMods`、CLI 输出「overrides N 个文件（其中 mods/ 里 M 个 jar）」。

## Consequences

- 无 key 的 CF 包从「一条命令都跑不了」变成「装到能 boot 的骨架 + 一张待补清单」。
  代价是这类实例的 `preflight` 会满屏 `MISSING_DEPENDENCY`——这是事实，不是误报。
- `extractOverrides` 的返回值从 `number` 变成 `{files, mods}`，调用方只有 `deploy`。
- 新增 `blockpilot forge|neoforge <mc> [--loader <ver>]`：否则 CF 包即使手工解开
  overrides，也没有命令能装加载器（issue #13 的第 3 点）。它先跑原版 setup
  再跑官方 installer，因为 natives 只有 setup 会解压。
