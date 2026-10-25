# 0014. 用真实整合包压：Fabulously Optimized

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0012、ADR-0013

## Context

自造的 fixture 只能证明「按我的理解能跑」。真实的整合包有作者自己的写法、奇怪的版本约束、几十个配置文件——这些才是缺陷的来源。

选的样本：**Fabulously Optimized 6.5.0**（1938 万下载，Modrinth 上最主流的 Fabric 性能包）。

| 指标 | 值 |
|---|---|
| jar 数 | 50 |
| 模组总大小 | 42.3 MB |
| overrides 文件 | 64 |
| MC / loader | 1.21.1 / Fabric 0.19.3 |

## 结果

**部署**：50/50 全部下载，63 个 overrides 解压，0 失败。

**检查**：第一遍 `BLOCKED`，修完之后 `OK`。

**启动**：

```
Loading Minecraft 1.21.1 with Fabric Loader 0.19.3
Loading 151 mods:
Setting user: Player
OpenGL Version: 3.2.13596 Core Profile ...
Initializing ImmediatelyFast 1.6.10+1.21.1 on AMD Radeon(TM) Graphics
```

151 而不是 50，因为 Fabric API 等模组自带子模块。

## 压出来的三个 bug

### 1. 不支持 `~` 和 `^`

真实整合包里 controlify / zoomify / yet_another_config_lib_v3 声明的是：

```
minecraft: "~1.21 <1.21.2"
```

`~1.21` 是 npm semver 的「锁次版本」写法，等价 `>=1.21.0 <1.22.0`。我的解析器不认识它，直接判成不兼容——**对一份完全正常的整合包报 `BLOCKED`**。

这是最恶劣的一类 bug：如果用户第一次用就撞上，他不会怀疑是启动器错了，而是觉得「这破工具连官方整合包都不支持」。

### 2. `unknown` 被当成了 `violated`

ADR-0013 里明明白白写着「unknown 不当作违规，宁可漏报不可错报」，实现里却写成：

```ts
if (r === null) { anyUnknown = true; break }
...
if (allOk && !anyUnknown) return 'satisfied'
return 'violated'   // ← 未知落到了这里
```

文档和实现不一致，而且测试没覆盖到这个分支。**规则写在注释里不等于被执行**。

### 3. `/[xX*]/` 把单词里的 x 当通配符

`next-please` 里有 `x`，被通配分支吃掉了，返回明确的 `false` 而不是 `null`。

修法：按段判断，`segments.some(s => s === 'x')` 而不是整串正则。

## 教训

三个 bug 有两种性质：

- 1 和 3 是**语法覆盖不足**，只有见到真实写法才会暴露
- 2 是**实现与设计不一致**，测试写少了

共同点是：自造 fixture 全都测不出来。我的 fixture 里写的都是 `">=1.20.1"` 这种最规矩的形式。

## 遗留

- **1.21.1 的 assets 需要单独下载**（约 700 MB）。不装也能启动，但会刷 `Failed to open pack ... assets/objects/...`，而且没有声音。
- `controlify` 报 `Found a remappable @Shadow annotation`——这是该 mod 与 loader 0.19.3 的兼容问题，不是启动器的责任，但说明「检查 OK 也不等于 mod 之间百分百和谐」。

## 后续

拿 2–3 个不同规模的整合包做成回归集（一个 10 mod、一个 50 mod、一个 200+ mod），每次改检查逻辑都跑一遍。这份压测的价值不在「跑通了一次」，在于把「真实写法」变成了测试输入。
