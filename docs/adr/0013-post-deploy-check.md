# 0013. 部署后自检：装在完 ≠ 能跑

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0004、ADR-0012

## Context

`deploy` 把文件装齐了，但装齐不等于能启动。实测踩到：

```
模组 'Fabric API' (fabric-api) 0.92.12+1.20.1 需要 模组 'Fabric Loader'
(fabricloader) 的 0.16.10 及以上版本，但已经安装了的版本 0.15.11 不对！
```

这条错误埋在几百行日志中间，用户看到的是"游戏闪退"。

## Decision

### 1. deploy 末尾跑一次离线检查

复用 `checkLocalInstance`——同一个函数既服务 `preflight <目录>`，也服务 deploy，避免两套逻辑漂移。

### 2. 离线检查从「在不在」升级到「版本够不够」

之前 `checkLocalDeps` 只判断依赖的 modId 是否出现在实例里。现在多了版本比对：

| 问题 | 判定方式 |
|---|---|
| 缺前置 | modId 不在 present 集合 |
| 版本不符 | modId 在，但版本不满足声明的范围 |
| 环境不符 | `minecraft` / `fabricloader` 的约束用实例版本判定 |

新增 finding code：`DEPENDENCY_VERSION_MISMATCH`。

### 3. 版本范围要同时支持两套语法

- Fabric：semver 表达式 `>=0.16.10`、`>=1.20.1 <1.21`、`1.20.x`
- Forge：Maven 范围 `[1.20.1,1.21)`、`[0.6.10,)`

`semver.ts` 返回三档而不是布尔：

```ts
type RangeVerdict = 'satisfied' | 'violated' | 'unknown'
```

`unknown` 表示「看不懂这个写法」，**不当作违规**。宁可漏报，不可错报——一个动辄说「版本不兼容」的检查器，用户三天就学会无视它。

## 关键发现：jar-in-jar

第一版跑出来是这样：

```
✗ MISSING_DEPENDENCY  sodium 需要前置模组 fabric-rendering-data-attachment-v1
✗ MISSING_DEPENDENCY  sodium 需要前置模组 fabric-rendering-fluids-v1
✗ DEPENDENCY_VERSION_MISMATCH  fabric-api 要求 fabricloader >=0.16.10
```

前两条是**假阳性**——fabric-api 明明装了。

原因：**Fabric API 0.92+ 把 57 个子模块拆成了 `META-INF/jars/*.jar`**，最外层的 `fabric.mod.json` 只有 `id: fabric-api`，`provides` 是空的。子模块在嵌套 jar 里，各自有自己的 `fabric.mod.json`。

修法：`readModMetadata` 除了 4 个候选文件，还要解 `META-INF/jars/` 下的 jar，把里面声明的 modId 和版本收集到 `nested` 字段，再并入 present 集合。

修复后同一份实例只剩一条真问题。

## Consequences

**Positive**

- 坏包在启动前就被拦下，错误信息直指「loader 版本太低」。
- 好包明确说「没有发现阻塞项」，用户敢启动。
- `semver.ts` 有 11 个用例，覆盖 AND / OR / 通配 / Maven 闭开区间。

**Negative**

- 版本范围只覆盖常见写法，`~` / `^` / 预发布排序都没做（返回 `unknown`）。
- jar-in-jar 只读一层，嵌套里的嵌套不读（实际很少见）。
- 检查是**同步阻塞**的：Fabric API 有 57 个嵌套 jar，每个都要解压读 JSON，大实例会慢几百毫秒。

## 实测

坏包（loader 0.15.11 + fabric-api 0.92.12）：

```
部署后检查  BLOCKED
  ✗ DEPENDENCY_VERSION_MISMATCH  fabric-api 要求 fabricloader >=0.16.10，实际是 0.15.11
    → 加载器版本太低，换更高的 loader 版本重装

先别启动，上面这些会直接导致崩溃
```

好包（loader 0.16.14）：

```
部署后检查  OK
  没有发现阻塞项

启动
  blockpilot run fabric-loader-0.16.14-1.20.1 --root ...
```
