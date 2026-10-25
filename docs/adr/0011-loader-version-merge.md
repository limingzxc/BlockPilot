# 0011. 加载器版本合并：inheritsFrom 的三个坑

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0007、ADR-0010

## Context

Fabric / Forge 的版本 JSON 是**不完整**的。Fabric 的 profile 只有 8 个库和自己的主类：

```json
{
  "id": "fabric-loader-0.15.11-1.20.1",
  "inheritsFrom": "1.20.1",
  "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
  "libraries": [...],
  "arguments": { "jvm": ["-DFabricMcEmu=net.minecraft.client.main.Main"], "game": [] }
}
```

原版的 88 个库、`-cp` 参数、assets、client jar 全在父 JSON 里。所以要合并。

## Decision

### 1. 先看本地，再远程

加载器版本只存在于 `versions/<id>/<id>.json`，Mojang 的 manifest 里没有它。先远程会直接 404。

### 2. libraries 去重：`group:artifact:classifier`

**版本不进 key**，这样加载器的 `asm:9.10.1` 才能覆盖原版的 `asm:9.7`。
**classifier 必须进 key**，这是踩出来的坑（见下）。

### 3. arguments 拼接，不是替换

子 JSON 只写自己新增的参数。父的 `-cp`、`-Djava.library.path` 全在原版里，替换掉就启动不了。

### 4. 只覆盖子 JSON 明确给了值的字段

Fabric profile 没有 `downloads` / `assetIndex`，直接 `{...parent, ...child}` 会把它们变成 `undefined`。

## 三个坑（都是实测出来的）

### 坑一：classifier 没进 key

第一版 `libraryKey` 只用 `group:artifact`：

```ts
org.lwjgl:lwjgl:3.3.1
org.lwjgl:lwjgl:3.3.1:natives-windows
org.lwjgl:lwjgl:3.3.1:natives-windows-arm64
```

这三个的 key 都是 `org.lwjgl:lwjgl`，合并时互相覆盖，最后只剩一个。

后果：原版 88 个库被压成 **53** 个，lwjgl 主 jar 消失，启动时报

```
NoClassDefFoundError: org/lwjgl/system/MemoryUtil
```

诡异之处在于**原版能跑，装了 Fabric 就崩**——因为原版走的是不合并的路径。

### 坑二：natives 目录用了 `version.id`

`setup` 按原版 id 解压 natives（`natives/1.20.1`），而加载器版本启动时去 `natives/fabric-loader-0.15.11-1.20.1` 找——空目录。

要用 **rootId**。

### 坑三：client jar 用了 `version.id`

加载器版本没有自己的 client jar，`versions/fabric-loader-.../fabric-loader-....jar` 不存在。也要用 rootId。

## Consequences

**Positive**

- 一套合并逻辑同时覆盖 Fabric 和 Forge（Forge 的 `inheritsFrom` 用法相同）。
- `resolveVersion` 返回 `{ json, rootId }`，把「根版本是谁」这件事显式化，caller 不会用错。
- 7 个单测锁住去重规则、拼接语义、字段覆盖。

**Negative**

- 没有做 `+` 之外的 library 排除规则（某些加载器用 `-` 标记排除父库）。
- Forge 的 installer jar 还没支持——它需要跑安装程序产出 profile，比 Fabric 复杂。
- 合并结果的 `id` 是加载器的，但 `assetIndex` 是原版的，调试时容易看混。

## 实测

```
[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.11
[Render thread/INFO]: Setting user: Player
[Render thread/INFO]: OpenAL initialized on device OpenAL Soft on ...
[Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas
```

**这是 Modrinth 整合包能跑的前提**——`.mrpack` 里的 mod 都依赖 Fabric/Forge。

顺带一个发现：默认取「最新 stable loader」（0.20.1）能加载但会崩在 `RenderSystem`，换同期版本 0.15.11 正常。三年跨度的 loader 不保证兼容，`--loader` 参数是必要的逃生口。
