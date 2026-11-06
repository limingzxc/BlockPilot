# 0029. CurseForge 整合包用用户自己的 API key 安装

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @liming
- **Depends on**: ADR-0021、ADR-0014

## Context

ADR-0021 定过界线：CF 的 `manifest.json` 只有 `projectID/fileID`，没有 URL 也没有哈希，
没有 API key 就装不了；`preflight` 可以读版本与加载器，`deploy` 直接拒绝。

2026-11-07 的 B 站评论区实测把这条界线的代价摆出来了：评论区 top 10 的整合包里
9 个不在 Modrinth，RLCraft / ATM 这类都在 CurseForge。用户自己把
`RLCraft 2.9.3.zip`（187 文件）和 `落幕曲 1.6.8.zip`（271 文件，480 MB）下下来了，
`deploy` 仍然只能说「需要 API key」。

用户随后提供了自己的 CF key。CF 的 `POST /v1/mods/files` 一次能换回 100 个文件的
`downloadUrl` + `sha1`，RLCraft 187/187、落幕曲 271/271 都能解析——路是通的。

## Decision

1. **key 只从环境变量 `BLOCKPILOT_CF_API_KEY` 读**，不接受命令行参数（会进 shell history），
   不写任何文件、不打日志。测试时用进程级 env 传入。
2. `deploy` 遇到 CF 包：
   - 没 key → 仍然是 `CF_API_REQUIRED`，提示写清楚要设哪个环境变量；
   - 有 key → 用 `CurseforgeSource.getFiles()` 换 URL 与 sha1，构造与 mrpack 相同的
     `DownloadTask`（落到 `mods/`），后面走同一套原版安装 / 加载器 / overrides / 自检；
   - key 无效 → `CF_API_KEY_INVALID`；限流 → `CF_API_RATE_LIMIT`；网络问题 → `NETWORK_ERROR`。
3. **换不到 URL 的文件必须报出来，不能静默丢弃**。三种情况：
   作者关闭第三方下载（`downloadUrl: null`）、API 没返回该 fileID、没有 sha1。
   它们进 `failed`，退出码 2——「装完了」不能建立在「有几个文件没装」之上。
4. `preflight` 的 CF 行为不变（没有 key 也能看版本与加载器）。等有 key 再做 mod 级校验。

## Consequences

**Positive**

- B 站评论区点名的 CF 包终于能装。RLCraft 实测：185/187 下载、3381 个 overrides、
  340 MB，部署后检查 OK。
- 不需要申请第三方代理，也不碰 CF 网页的 Cloudflare；key 是用户自己的，配额也归用户。

**Negative**

- 用户要自己去 `console.curseforge.com` 申请 key（免费）。这一步绕不过去，写进 README。
- 有些包会有少量文件拿不到（落幕曲 19/271、RLCraft 2/187），这类包只能装个「大部分」，
  退出码会是 2。要么作者放开第三方下载，要么手动补文件。
- key 进环境变量仍有泄露面（进程列表、CI 日志）。文档里明确别写进脚本。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 抓 CurseForge 网页 | Cloudflare 挡，且违反 ToS |
| 用 cfwidget 之类的第三方索引 | 能拿到文件名与链接，但**没有 sha1**；ADR-0005 的底线是不能校验就不落盘 |
| 让用户手动把文件拖进 mods/ | 等于让 BlockPilot 退化成启动器壳，且无法保证版本正确 |
| 把 key 放命令行 `--cf-key` | 进 shell history 与进程列表，比 env 更差 |

## 验证

- 真实包：`RLCraft 1.12.2 - Release v2.9.3.zip` → `deploy` → 185 文件 / 3381 overrides /
  部署后检查 OK；`落幕曲 1.6.8` 的 271 个 fileID 全部解析（19 个无直链，会进 failed）。
- 单测：`buildCurseforgeTasks` 4 条（正常映射、无直链、API 缺失、同名不覆盖）。
- 失败码：无 key / 错 key / 限流三条路径都有稳定 code。
