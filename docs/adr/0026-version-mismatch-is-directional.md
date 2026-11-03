# 0026. 「版本不匹配」要分级：作者没勾，不等于跑不了

- **Status**: Proposed
- **Date**: 2026-10-29
- **Deciders**: @liming
- **Depends on**: ADR-0002、ADR-0013、ADR-0025

> 待决：本文只提出判定级别的调整，代码未改。落地前需要 @liming 确认。

## Context

2026-10-29 的手工实测（`docs/testing/2026-10-29-manual.md`）用 Modrinth 上的
**Fabulously Optimized 14.1.1**（MC 26.2 + Fabric 0.19.5，51 个模组）走主链路：

```
$ blockpilot preflight Fabulously.Optimized-v14.1.1.mrpack
  verdict   BLOCKED
  ✗ VERSION_MISMATCH  MixinTrace Reborn 1.0 for 26.1 Universal 不支持 Minecraft 26.2
    → 该模组支持的版本：26.1, 26.1.1, 26.1.2
  exit 2
```

装完之后，对同一个包再查一次（此时读的是实例里的 jar）：

```
$ blockpilot deploy ... && blockpilot preflight <实例目录>
  装好了  26.2 + fabric 0.19.5 · 模组 51 个（失败 0）· 部署后检查 OK
  verdict   OK
  mods      49  (resolved 49, unresolved 0)
```

两次结论相反。查包里那个被判「不支持」的 jar：

```
$ unzip -p mods/mixintrace-1.0-26.1-universal.jar fabric.mod.json
depends: {"minecraft":"26.x"}
```

`26.x` 覆盖 26.2。**jar 内的声明说支持，Modrinth 网页上的 `game_versions`
列表只到 26.1.2。**

关键事实：Modrinth 的 `game_versions` 是作者发版时**手动勾选**的清单，与 jar 内的
`depends` 是两份独立数据。作者升了兼容性但没回去补勾，是生态里极常见的情况。
预检只看得到前者（`.mrpack` 里没有 jar）。

这与 ADR-0025 处理 JiJ 依赖的那个推理是同一个：**「在线元数据里没有」只能证明
「没写」，不能证明「不支持」**。ADR-0025 已经把缺依赖降成 `warning`，但
`VERSION_MISMATCH` 还停在 `blocker`。

### 为什么不能简单地全降成 warning

「模组太新、游戏太老」和「模组太老、游戏太新」不是一回事：

- 目标版本 **低于** 模组声明的最低支持版本（例如把 1.21 的模组装进 1.20.1）：
  模组用到的 API 在那个版本里可能根本不存在，**必崩**。这是硬结论。
- 目标版本 **高于** 声明（本例 26.2 > 26.1.2）：模组可能只是没被作者勾进新版本，
  也可能真的没适配。这是软结论。

现在的实现把两者混为一谈，都是 `blocker`。

## Decision

1. **`VERSION_MISMATCH` 按方向分级**：
   - 目标版本 **低于** `gameVersions` 的最低值 → 保持 `blocker`
     （措辞：「该模组最低要求 X，不会在 Y 上工作」）
   - 目标版本 **高于** 最高值 → 降为 `warning`，code 改为
     `VERSION_UNVERIFIED`（措辞：「作者标注的版本里没有 X，可能还没适配，也可能只是没勾」）
2. **hint 指向可确认的那一步**：装完跑 `blockpilot preflight <实例目录>`，
   那一刻读的是真 jar，结论确定。
3. 需要在 `semver.ts` 导出一个 `compareVersions(a, b): number`
   （内部已有 `parseVersion` + `compare`，能处理 `26.2` 这种两位版本号）。
4. 目标版本在列表中间（正常命中）时行为不变。

## Consequences

**Positive**

- 官方稳定整合包不再因为一个 7 KB 的调试模组被判「装不上」。这类包的用户量在
  千万级，第一次用就撞上，用户不会怀疑是检查器错了。
- 与 ADR-0025 的边界一致：预检说「据我所知」，装完的离线检查说「我看到」。
- 保留了对真错的拦截：把新模组装进老游戏仍然 `blocker`。

**Negative**

- 真正没适配的新版本模组会漏报成 `warning`，用户可能装完才发现。缓解手段是
  部署后检查（`deploy` 已经会做）与实例预检。
- `BLOCKED → WARN` 是退出码变化（2 → 0），依赖退出码的脚本行为会变。这是
  有意的：现在的退出码在说谎。
- 需要维护一份「版本怎么比」的约定；快照版本（`26.4-snapshot-6`）与正式版的
  先后关系没有权威定义，只能按字符串/数字顺序近似。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 全部降成 warning（不分方向） | 「装 1.21 模组到 1.20.1」这种必崩的组合会漏报。两个方向的可信度不同，不该合并 |
| 保持 blocker，只在 hint 里加一句「可能是没勾」 | 退出码仍是 2、verdict 仍是 BLOCKED，用户和脚本的判断照样被带偏 |
| 下载 jar 再读 `depends` | 违反「预检不下载游戏文件」；为 50 个文件里的一个拉几百 KB，还把网络依赖带进纯检查（同 ADR-0025 的否决） |
| 改成 `info` | 连提醒都不算，用户完全看不到「这个模组没在新版本上验过」 |

## 验证

落地后需要：

- **正向**：`Fabulously.Optimized-v14.1.1.mrpack`（目标 26.2，MixinTrace 声明到
  26.1.2）必须输出 `WARN` / 退出码 0，且 `VERSION_UNVERIFIED` 出现在 findings 里。
- **反向**：构造一个声明 `1.21.1` 的包，把目标改成 `1.20.1`，必须仍是 `BLOCKED`。
- **不回归**：E2E-101（真实 FO 6.5.0 不得出现 blocker）。
- 单测：`check.test.ts` 现有的「游戏版本不匹配 → VERSION_MISMATCH」要拆成上下两个方向各一条。
