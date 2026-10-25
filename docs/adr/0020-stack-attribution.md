# 0020. 栈帧归属：只说有证据的那一半

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0019

## Context

ADR-0019 的 `diag` 能说出「mixin 冲突」，说不出「是谁和谁冲突」。对人不算致命——看一眼栈帧里的包名就知道了。对 AI 是致命的：没有主语，它只能去猜，而猜错的代价是让用户删掉一个无辜的模组。

把栈帧映射到模组需要两样东西：**帧**和**身份**。

帧好办，`at com.example.Foo.bar(Foo.java:42)` 是稳定格式。身份难办：栈帧里只有类名，模组身份要么在 jar 的元数据里，要么在日志的某处被顺手打印了出来。

## Decision

### 1. 三类证据，强度不同，绝不混为一谈

| 强度 | 证据 | 为什么可信 |
|---|---|---|
| 100 | 根因区段最上面那一帧 | 位置本身就是信息，见下一节 |
| 60 | `handler$zcb000$sodium$method_1` | Fabric 的 mixin 命名规范，mod id 是方法名的一部分 |
| 50 | `~[jei-...jar%23123!/:?]` | Forge / ModLauncher 在帧尾打印的真实来源 |
| 40 | `controlify.mixins.json` | mixin 报错时的确切主语 |
| 10 | 包名属于某个 jar | 事实，但「包在这个 jar 里」不等于「是这个模组干的」 |

前四类是**日志自己说的**，不需要推断。只有第五类需要扫 jar，所以它权重最低。

### 2. 根因区段：最后一条 `Caused by` 之后

```
java.lang.RuntimeException: Rendering overlay
    at com.mojang.blaze3d...RenderSystem.replayQueue   ← 表层，通常是原版
Caused by: java.lang.NullPointerException
    at dev.isxander.controlify.utils.RenderUtils.blit  ← 真正的抛出点
```

只看「第一帧」会把锅甩给原版；只看「帧数最多的模组」会甩给调用链最长的那个。**最深的 `Caused by` 之后的第一帧**才是抛出点。

### 3. 包名必须用完整路径，不能截断

第一版取前两段（`com/example`），测出大量误判；改成前一段三段（`net/caffeinemc/mods`），在真实的 50 mod 实例上直接失效：

```
net/caffeinemc/mods  ← sodium, lithium
```

两个模组共用这三段，于是**它们的栈帧全被当成「有歧义」丢掉了**。而这是真实世界的常见布局：同一个作者的多个模组放在同一个命名空间下。

改成索引完整包路径（`net/caffeinemc/mods/sodium/client/render`），查找时从长到短命中即止。50 mod 实例的索引量：**1278 个包前缀、371 ms**。

### 4. 有歧义就闭嘴

```ts
if (owners.length !== 1) return null
```

两个模组都声明了同一个包，说明它多半是共用库或者有人把别人的类打包了。这时候说「是 A」有一半概率是错的，而用户不会知道那是掷硬币的结果。

同理，这些包一律不参与归属：`net/minecraft/`、`com/mojang/`、`org/lwjgl/`、`org/spongepowered/`，以及 `org/apache/`、`com/google/`、`it/unimi/` 这类内嵌库。

### 5. 证据太弱就不改结论

```ts
if (top.score < 40) return primary
```

`mod-crash` 原来的 hint 是「看它前面几行的触发点，通常是某个模组」——那是**没有归属能力时**能说的话。现在知道是谁了，就换成「异常来自 jei，先禁用或更新它」。

但只在证据达到 40 分（至少是日志点过名）时才换。一条「包名看着像」不足以让用户去动手。

### 6. 只改被归因影响的结论

`java-version`、`out-of-memory`、`graphics` 这些运行时问题，把锅推给某个模组是错的——加内存不会因为换了个模组就变好。所以 `ATTRIBUTABLE` 只包含 `mod-crash` / `mod-load-failed` / `mixin`。

## 实现中撞到的两个真实缺陷

**1. Kotlin 的 `.kt` 帧被整个丢掉。**

第一版只接受 `Foo.java:42` 形式的源码位置。controlify 是 Kotlin 写的，它的帧长这样：

```
at dev.isxander.controlify.utils.RenderUtils.blit(RenderUtils.kt:88)
```

于是这个模组在崩溃现场里**一帧都没有**，归属结果为空。改成接受任意 `名字.扩展名:行号`。

**2. `Controlify（controlify）` 把同一个词写了两遍。**

显示名和 modId 常常只差大小写。现在只在两者明显不同时才并列。

## Consequences

- `diag` 的输出多了一节「指向的模组」，带证据和一句代表性帧
- `diagnose_crash` 成为第二个 MCP 工具。工具描述里明确写：**culprits 为空时不许猜名字**
- 扫 jar 的成本与模组数量线性相关。50 mod / 371 ms 可以接受；200 mod 的包会更慢，但 `diag` 不是高频命令，暂不做缓存
- 归属不到的情况会被显式说明（「日志里没有栈帧」/「mods 目录为空」/「异常来自原版或某个库」），而不是静默返回空数组

## 已知局限

- 嵌套 jar 只扫一层（`META-INF/jars/*.jar`、`META-INF/jarjar/*.jar`）。实测这一层就覆盖了 Fabric API 的 57 个子模块，但再深一层没有处理
- 只有一份日志时，`Caused by` 的层级关系只能按出现顺序判断。真实崩溃常常有多份日志
- 说不出「A 和 B 冲突」。能指认 A，但 B 是隐形的——它可能压根没出现在栈里

## 代价

扫 jar 的耗时随模组数量线性增长，且**每次 `diag` 都重扫**：

| 实例 | 包前缀 | 耗时 |
|---|---|---|
| 46 mod（Fabulously Optimized） | 1661 | 635 ms |

其中约 40% 花在解压嵌套 jar 上。没做缓存的原因：`diag` 不是高频命令，而缓存键要把每个 jar 的 mtime 和大小都算进去，失效逻辑比省下的 600 ms 更贵。

实测暴露的另一个现象：controlify 把 YACL 的类打包进了自己的 jar（`dev/isxander/yacl3/*` 同时属于 `controlify` 和 `yet_another_config_lib_v3`）。这类包被判为「有歧义、不指认」——符合预期，因为从栈帧确实分不出是哪一个。
