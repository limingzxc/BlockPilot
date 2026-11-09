# 0046. `deploy` 接受 Modrinth project slug

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0003（内容源边界）、ADR-0040（本次边界）

## Context

`deploy` 只接受本地 `.mrpack` / CF zip。用户从 Modrinth 页面复制的是
`fabulously-optimized` 这样的 slug，不是文件路径；为了装一个包，得先手动
下载、记住放在哪，再传路径。这是纯摩擦。

## Decision

`deploy <target>` 的判定顺序：

1. `existsSync(target)` → 本地文件，行为不变。
2. 像 slug（`^[0-9A-Za-z][0-9A-Za-z_-]{1,63}$`，且不以 `.mrpack/.zip` 结尾）
   → 调 Modrinth `GET /v2/project/<slug>/version`，取第一个 `release`（没有就第一个），
   选 primary `.mrpack`（没有就第一个 `.mrpack`，再没有就第一个文件）。
3. 其他（含路径分隔符、包后缀、不合法 slug）→ 原样交给 `createDeploy`，
   让 `BAD_MODPACK` 带上用户输入，不吞掉「路径打错了」。

下载落到 `<root>/cache/packs/<filename>`，复用 `downloadOne` 的哈希校验与镜像。
`--china` 时查询走 MCIM 镜像。

## Consequences

**Positive**

- `blockpilot deploy fabulously-optimized` 可以直接工作。
- 下载的包留在 cache，重跑 deploy 不用再下一次。

**Negative**

- slug 查询不按 MC / 加载器过滤，取的是项目的最新 release；如果用户想要旧版本，
  仍需自己下载后传路径。
- 本地不存在、又长得像 slug 的路径（比如 `mypack` 目录被删了）会被当成 slug
  去查 Modrinth，报「找不到」而不是「文件不存在」。提示里已说明两种输入。
- 只支持 Modrinth；CurseForge 的 slug 仍需网页下载。

## 验证

- `src/sources/modrinth.test.ts`：slug 查询 URL、release 优先、非法 slug 不发请求
- 手工：`blockpilot deploy fabulously-optimized --instance fo`（需要网络）
