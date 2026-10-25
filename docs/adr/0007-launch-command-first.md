# 0007. 先出命令，再启进程

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0001

## Context

启动是最容易出错的一步，而且**错误信息会指向完全无关的地方**：

| 真实原因 | 玩家看到的 |
|---|---|
| classpath 用了 `:` 而不是 `;` | `找不到主类 net.minecraft.client.main.Main` |
| `${clientid}` 没替换 | `Invalid parameter: ${clientid}` 或者直接闪退 |
| rules 没过滤 macOS 专用库 | `UnsatisfiedLinkError: no lwjgl in java.library.path` |
| natives 没解压 | `Failed to create window` |

一次错一次重启，排查成本极高。

## Decision

### 1. 生成命令与启动进程分成两步

`launch` 目前**只生成并打印命令**，不 spawn 进程。等命令经过人工核对、且缺失文件补齐之后，再加最后那一步 `spawn`。

### 2. 生成器是纯函数

`buildLaunchPlan()` 不读时钟、不发网络、不写磁盘（只做 `existsSync` 检查）。version JSON 由外部传入。这样：

- 可以用假 JSON 写单元测试，不依赖 Mojang 的接口
- 同样的输入永远得到同样的输出，出问题时可以逐字段比对

### 3. rules 的语义是「最后一条匹配生效」

Mojang 的规则不是「任意 allow 就放行」：

```json
{ "rules": [{ "action": "allow" }, { "action": "disallow", "os": { "name": "osx" } }] }
```

这段的意思是「除了 macOS 都允许」。实现必须按顺序遍历，每条匹配的规则覆盖之前的结果，默认值是不允许。

### 4. 替换完要检查残留

模板替换最容易出的事不是替换错，是**压根没替换**。所以测试里有一条硬断言：

```ts
const leftovers = plan.args.filter((a) => /\$\{[a-zA-Z0-9_]+\}/.test(a))
assert.deepEqual(leftovers, [])
```

这条断言在这次开发里立刻抓到两个漏掉的变量：`${clientid}` 和 `${auth_xuid}`（1.18+ 的 `game` args 会引用它们）。

### 5. 缺失文件检查覆盖三类

client jar、每个 library jar、`assets/indexes/<id>.json`。只查前两类会漏掉 assetIndex，而它缺失时游戏会在初始化阶段报一个很模糊的错。

### 6. 离线模式给占位值，不给空字符串

`clientid` / `auth_xuid` 填 `'0'` 而不是 `''`。空字符串会变成两个独立的空参数，游戏解析时行为不可预期；`'0'` 至少是一个合法的字符串值。

## Consequences

**Positive**

- 命令可以在补文件之前就被人检查，参数错误在零成本时暴露。
- 11 个单测覆盖 rules 语义、参数展开、占位符替换、classpath 过滤、缺失检查。
- 同一个生成器将来可以直接喂给 `spawn`，不用重写。

**Negative**

- **还不能真的启动游戏。** 这是刻意的：先把 65 个 jar 的 classpath 拼对，再谈进程管理。
- 没有处理 natives 解压（`libraries` 里的 `classifiers` / `natives` 字段已解析出来，但没有落地）。
- assets 只检查 index 文件，不检查那几千个资源对象。
- 没有加载器（Forge/Fabric）的启动参数——那需要另外合并 loader 的 version JSON。

## 实测

对 1.20.1（干净目录）：

```
版本      1.20.1
Java      D:\graalvm-jdk-21.0.4+8.1\bin\java.exe
主类      net.minecraft.client.main.Main
类路径    65 个 jar
缺失      67 个文件
```

命令里的 `-cp` 折叠成 `<65 jars>` 展示，`--raw` 可看完整值。
