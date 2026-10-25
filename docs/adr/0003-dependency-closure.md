# 0003. 依赖解析的边界：做闭包，不做版本求解

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0002

## Context

实现递归依赖闭包时，有三个问题必须表态，否则代码会写成一团浆糊：

1. **版本范围**：Modrinth 的 `version.dependencies` 只有 `project_id` / `version_id`，**没有 semver range**。也就是说，A 依赖 B 这件事，元数据只能表达成「B 的某一个版本」，不能表达成「B >= 1.2 < 2.0」。
2. **冲突**：A 要 B@1.x，C 要 B@2.x，而实例里没有 B——装哪个？
3. **循环**：`a → b → a` 算不算问题？

## Decision

### 1. 只做 `required`

`optional` 和 `embedded` 不进闭包。理由：可选依赖缺了不影响启动，把它们算进来会让报告充满噪音，用户会学会无视它。

### 2. 不做版本求解，同一 project 只解析一次

缺 B 时，向内容源要一个「兼容当前 gameVersion + loader 的最新 release」。如果两个模组都要 B，只用这一个版本。

**这不是偷懒，是元数据不支持更精确的做法。** 在只有 project 级依赖的数据上做版本求解，等于用假精度骗自己。

### 3. 循环只在「需要新装的部分」检测

`a → b → a` 且 a、b 都在实例里，是**已满足的闭环**，不报。

只有「a 已装，b、c 都不在，而 b ⇄ c 互相依赖」才是真循环。此时报 `DEPENDENCY_CYCLE`，级别是 `warning` 而不是 `blocker`——多数加载器能容忍这种声明，它通常意味着模组元数据写错了，但未必跑不起来。

### 4. 反查失败不是异常

`DependencyResolver.resolve()` 查不到就返回 `null`，不抛错。在闭包里，「找不到」是常态结局之一，对应 `UNSATISFIABLE_DEPENDENCY`。

### 5. 有硬上限

最多反查 200 个缺失 project。触顶后停止展开，报 `CLOSURE_TRUNCATED`，并且**不允许把结论说成 ok**。真实整合包通常只有个位数缺失，200 是防御性的。

## Consequences

**Positive**

- 算法确定性：给定同样的元数据，永远得到同样的结论，可写单元测试（当前 8 个用例覆盖单层、递归、循环、已满足闭环、上限截断）。
- 不会误报「版本冲突」——因为压根不判断版本，只判断「在不在」。
- 反查是按需发生的：实例里的模组不反查，只有缺失的才发请求。一个 400 模组的整合包，通常只发个位数请求。

**Negative**

- **真实的版本冲突查不出来**。如果 A 需要 B 的 1.x API、而最新 release 是 2.x，我们推荐了一个装不上的版本。这个洞只能靠 `UNSATISFIABLE` 的 hint 提示用户人工确认。
- 报的是 `projectId` 不是项目名。要显示人类可读的名字，得再查一次 `/v2/projects`。第一版没做，因为闭包阶段多发请求不值得。
- CurseForge 的整合包走不通——它的依赖关系粒度更粗（只有项目级 relations），且需要 API key。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 完整 CSP / SAT 求解 | 需要版本范围数据。Modrinth 的元数据里没有，Forge 的 `mods.toml` 里有但拿不到（在 jar 里）。强行做等于在残缺数据上求精确解 |
| 只查一层（上一版实现） | 会漏掉「依赖的依赖」。Iris → Sodium → ...这类链条在真实整合包里很常见 |
| 把 optional 也算进闭包 | 会淹没真实问题。一个大型整合包里 optional 依赖可能有几十个 |

## 验证

`fixtures/closure.mrpack` 只装 Iris 1.7.6（不装 Sodium），预检输出：

```
verdict   BLOCKED
mods      1  (resolved 1, unresolved 0)

✗ MISSING_DEPENDENCY  YL57xq9U 需要前置模组 AANobbMI，它不在实例中
  → 可安装 Sodium 0.5.13 for Fabric
```

Sodium 不在这个整合包里，是从 Iris 的依赖声明跨模组反查出来的真实版本。
