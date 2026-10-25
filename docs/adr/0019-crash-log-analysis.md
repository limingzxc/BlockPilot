# 0019. 崩溃日志分析：区分原因和结果

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0018

## Context

ADR-0018 把日志存下来了，但没人读。而「AI 读崩溃日志」本来就是项目的出发点。

日志里的信息有个特点：**一个根因会派生出好几条错误**。mixin 冲突 → 模组加载失败 → `ModLoadingException` → 游戏退出。四条日志，一件事。

## Decision

### 1. 规则表匹配，不解析堆栈

```ts
{ re: /UnsupportedClassVersionError|compiled by a more recent version/i,
  kind: 'java-version', severity: 'fatal',
  hint: '模组或游戏要求的 Java 版本比当前高。装对应版本：blockpilot java install <major>' }
```

按行扫，命中就记一条 `CrashSignal`（kind / severity / 行号 / 上下文 / hint）。

**hint 必须是可执行的**。「Java 版本不对」是复述现象，「装 Java 17」才是建议。

### 2. 同一 kind 只报第一次

连锁反应会重复产出同类错误。第一次出现的位置最接近根因。

### 3. 关键：区分「原因」和「结果」

第一版把 `ModLoadingException: Mod loading has failed` 判成 `missing-dependency`，severity `fatal`。输出长这样：

```
✗ mixin
✗ missing-dependency
✗ out-of-memory
```

三条并列，用户会以为要修三件事。

但真相是：`ModLoadingException` 是**容器**——mixin 冲突、缺依赖、模组自身 bug 都会汇到它。把它判成 fatal，等于把症状当病因。

改成独立 kind，severity 降级：

```ts
{ re: /ModLoadingException|Mod loading has failed/i,
  kind: 'mod-load-failed', severity: 'warning',
  hint: '这是结果不是原因。往上看它之前的第一条 ERROR，那里才是根因' }
```

渲染也跟着改：

```
最可能的根因

  ✗ mixin  第 5 行
    InvalidMixinException: Found a remappable @Shadow annotation on method_2659
    → 模组之间的字节码改写冲突。通常是两个模组改同一个类，试着移除最近加的那个

其他线索（可能是连锁反应，别急着一个个修）

  ? mod-load-failed  第 6 行
    这是结果不是原因。往上看它之前的第一条 ERROR，那里才是根因
  ? out-of-memory  第 8 行
    内存不够。把 --memory 调大（如 4096），或减少模组数量
```

「别急着一个个修」这句是有意的——它直接对抗用户的自然反应。

## 规则覆盖

| kind | 匹配 | 依据 |
|---|---|---|
| `java-version` | `UnsupportedClassVersionError` / `compiled by a more recent version` | JDK 的标准措辞 |
| `out-of-memory` | `OutOfMemoryError` / `Java heap space` | JVM 标准 |
| `missing-dependency` | Fabric 的 `Missing or unsupported mandatory dependencies`、Forge 的 `MissingDependencyException` | 两个加载器的实际措辞 |
| `mod-load-failed` | `ModLoadingException` / `Mod loading has failed` | Forge 的结果性异常 |
| `mod-conflict` | `Duplicate mods found` / `two mods with the same id` | 加载器措辞 |
| `mixin` | `InvalidMixinException` / `MixinApplyError` / `Mixin apply failed` | Sponge Mixin 的异常类 |
| `natives` | `UnsatisfiedLinkError` / `no lwjgl in java.library.path` / `Could not initialize class org.lwjgl` | JDK + LWJGL |
| `graphics` | `GLFW error` / `Pixel format not accelerated` | GLFW |
| `mod-crash` | 任何 `*Exception` / `*Error` 行 | 兜底，降级为 warning |

## Consequences

**Positive**

- 崩溃后一条命令给出结论和下一步：`blockpilot diag`。
- `run` 崩溃时把 `diag` 放在建议第一步，排在 `preflight` 前面。
- 16 个单测覆盖每种规则 + 去重 + 不误报 INFO 行。

**Negative**

- **只能匹配已知模式**。没见过的崩溃会落到 `mod-crash`，只能提示「看它前面几行」。
- **无法真正判断因果链**。`primarySignal` 只是「第一条 fatal」，在真实日志里不一定对。
- 不认识具体的模组。能说「mixin 冲突」，说不出「是 A 和 B 冲突」。
- 不解析堆栈帧，拿不到出问题的类名与模组归属。

## 实测

用一份模拟的 Forge 崩溃日志（mixin 失败 + ModLoadingException + OOM）：

```
最可能的根因
  ✗ mixin  第 5 行
    InvalidMixinException: Found a remappable @Shadow annotation on method_2659

其他线索（可能是连锁反应，别急着一个个修）
  ? mod-load-failed  第 6 行
  ? out-of-memory  第 8 行
```

三件事被正确折叠成「一个根因 + 两个线索」。
