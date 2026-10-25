# 0006. Java 检测：探测进程，不读注册表

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0002

## Context

启动失败的第一大原因是 Java 版本不对。要做三件事：找到本机所有 Java、判断各自版本、决定够不够跑这个 MC 版本。

有两条路：读注册表/环境变量拿版本号，或者直接跑一次 `java -version`。

## Decision

### 1. 探测，不读注册表

跑 `java -XshowSettings:properties -version`，从 **stderr** 解析。

理由：注册表在 Windows 上只登记正规安装的 JDK，绿色版、压缩包解压的、启动器自己下的全都查不到；而 macOS/Linux 根本没有注册表这个概念。跑一次进程虽然慢，但跨平台一致，且能验证「这个路径真的能启动」。

### 2. 不解析 `java -version` 的第一行

那行格式随厂商变：

```
openjdk version "17.0.9" 2023-10-17
java version "17.0.9" 2023-10-17
openjdk version "21.0.4" 2024-07-16 LTS
```

而 properties 里的 `java.version = 17.0.9` 是稳定字段，且能顺带拿到 `java.vendor` 和 `os.arch`。

### 3. 先过滤路径，再探测

探测一个 JVM 要起一次进程（100–300 ms）。候选路径可能有上百个（各家厂商目录 × 各版本），盲探要几十秒。所以先用 `existsSync + isFile` 过滤，再去重、限并发（默认 4）。

### 4. 版本匹配分三档，不是布尔

这是实现时被抓出来的一个真 bug——第一版写成「必须存在恰好等于 need 的 Java」，结果本机只有 Java 21 时，跑 1.20.1 报 `JAVA_MISSING`，而 **Java 21 明明能跑 1.20.1**。

| 情况 | 判定 | 理由 |
|---|---|---|
| 有精确版本 | 通过（有更低版本时记一条 info） | 最稳 |
| 没有精确版本，有更高版本 | **warning** | Java 向后兼容，多数能跑；但老 Forge 常栽在 Java 17+ 的反射限制上，所以不能沉默 |
| 一个都不够 | blocker | 必然起不来 |

**为什么"只有更高版本"不判 blocker**：判 blocker 会把大量实际可玩的情况误报成跑不了，用户会立刻学会无视这个警告。

### 5. Java 检查独立于在线/离线模式

第一版把它放在 `checkInstance` 里，导致离线模式（目录扫描）完全跳过了 Java 检查——因为那条分支根本不调用 `checkInstance`。现在抽成独立的 `checkJava(instance, host)`，两条链路都跑。

## Consequences

**Positive**

- 跨平台一致，绿色版 JDK 也能发现。
- 探测失败会被记录（`rejected`），不是静默丢弃——用户能看出"这个路径我查过但不是 JVM"。
- 判定逻辑有 4 个单测覆盖三档情况。

**Negative**

- 扫描要 1–3 秒，所以 CLI 提供 `--no-host` 跳过。
- 不读注册表，某些只登记未装到标准路径的 JDK 会漏（靠 PATH 兜底）。
- **没有做 Java 自动下载**。`JAVA_MISSING` 的 hint 只告诉用户该装哪个版本，不代劳。

## 实证

本机扫到 1 个 Java 21（GraalVM，通过 PATH 找到，`D:\graalvm-jdk-21.0.4+8.1`）。对 1.20.1 实例的判定：

```
! JAVA_NEWER_ONLY  没有 Java 17，但检测到更高的 Java 21
  → 多数情况下能启动；若加载器报版本错误，装一个 Java 17
```

而不是修复前那条错误的 `✗ JAVA_MISSING`。
