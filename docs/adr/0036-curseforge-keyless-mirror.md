# 0036. CurseForge 默认不需要 key：走 MCIM 代理，key 只用来加速

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0021（CF 边界）、ADR-0029（CF 安装）、ADR-0032（无 key 降级）

## Context

ADR-0021/0029 把「CF 安装需要 API key」当作边界。真机上用户的反应很一致：
「PCL2 装整合包也没让填 key，Prism 也没有」。

这个观察是对的，但结论不是「key 不必要」，而是「**启动器替用户付了**」：
Prism/ATLauncher 这类应用在 CurseForge 有登记，key 随启动器分发；
开源项目把 key 写进仓库会立刻泄露并被吊销，不能照抄。

官方接口的约束是真的：manifest 里只有 `projectID/fileID`，文件名、URL、sha1
全都要查 API；批量接口 `POST /v1/mods/files` 必须带 `x-api-key`。

但我们已经在用 MCIM 的文件镜像（`cdn.modrinth.com` / `edge.forgecdn.net`）。
实测它的 `/curseforge` 前缀还代理了**查询**接口，且不需要 key：

```
GET https://mod.mcimirror.top/curseforge/v1/mods/238222
→ 200，latestFiles 带 downloadUrl 与 hashes
GET .../mods/238222/files/3040523
→ 200，downloadUrl = https://edge.forgecdn.net/files/3040/523/jei_…jar
POST .../mods/files（批量）
→ 404，没有代理
```

RLCraft 2.9.3 的 187 个 fileID 用它逐个查：**187/187 全部解析、185 个有直链
（2 个作者关闭第三方下载）、3.8 秒**——与官方接口的结果完全一致。

## Decision

1. `CurseforgeLike` 抽象出 `getFiles(files: {projectId, fileId}[])`：
   官方实现只用 fileId，镜像实现两者都要（URL 里带 projectId）。
2. 新增 `MirrorCurseforgeSource`：并发 6 逐个 `GET /v1/mods/{id}/files/{fid}`；
   404 视为「镜像没收录，让调用方按拿不到处理」；429 → `CF_API_RATE_LIMIT`。
3. `resolveCurseforge()` 决定用谁：**有 key（`--curseforge-key` 或
   `BLOCKPILOT_CF_API_KEY`）走官方批量接口；没有就走镜像**。
   `--no-cf-mirror` 关闭回落，复现老行为（未配置 → 降级安装）。
4. `deploy` 日志里打印 `CurseForge 解析源：MCIM · … / api.curseforge.com`，
   用户不用猜这次走的是哪条路。
5. `preflight` 的 `CF_API_REQUIRED` 改名为 `CF_NO_MOD_CHECK`：预检这一步仍然不做
   CF 的 mod 级校验（要逐文件查元数据，属于另一个量级的改动），但文案改成
   「装的时候不需要 key」，不再让用户以为被卡住。

## Consequences

- 用户侧与 PCL2 一致：`deploy <cf.zip>` 直接跑，没有 key 这一说。
- 代价：没有 key 时 271 个文件要 271 次请求（3.8 秒实测，可接受），
  且依赖 MCIM 的可用性——它挂了就退回 `--no-cf-mirror` 的老行为或配 key。
- 镜像结果不可缓存在本进程外：同一条命令重跑仍要再查一遍（下载走缓存，查询不走）。
  留给后续：按实例缓存 `fileID → CfFileInfo`。
- 官方路径保留，配额与权威性都在它那边；批量接口快一个数量级，值得留。
