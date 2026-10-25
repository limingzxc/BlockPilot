# 0016. NeoForge：同一套 installer，两套坐标

- **Status**: Accepted（代码层面）
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0015

## Context

NeoForge 是 Forge 在 1.20.1 之后的分叉，安装机制几乎一样：也有 installer jar，也用 BootstrapLauncher，也给 client 打补丁。

差别只在**坐标规则**。

## Decision

参数化 `installerSpec(kind, gameVersion, loaderVersion)`，而不是复制一份实现：

| | maven 路径 | 版本目录名 |
|---|---|---|
| Forge | `{mc}-{ver}/forge-{mc}-{ver}-installer.jar` | `{mc}-forge-{ver}` |
| NeoForge | `{ver}/neoforge-{ver}-installer.jar` | `neoforge-{ver}` |

关键差异：

- **NeoForge 的版本号不带 MC 前缀**。`21.1.66` 对应 MC 1.21.1，`20.4.237` 对应 1.20.4。
- **Forge 的目录名带 MC 前缀**（`1.20.1-forge-47.2.0`），NeoForge 不带（`neoforge-21.1.66`）。

这两条混用会 404 或者装到一个错的位置。

`recommendedForge()` 只对 Forge 有效——NeoForge 没有 promotions 接口，必须由 mrpack 显式给出 `neoforge` 版本（实际整合包都会给）。

## 未验证的部分

**NeoForge 的整条链路没有实测。** 原因很直接：

```
nslookup maven.neoforged.net  → 解析成功（143.244.51.59 等）
curl https://maven.neoforged.net/...  → 000（连接超时）
```

DNS 能解析但 TCP 连不上。这是网络环境问题，不是代码问题，但我不能假装验证过。

所以：

- 代码路径与 Forge 共用（`createForgeSetup` + `kind` 参数），逻辑上成立
- **installer 的 URL、目录名、`--installClient` 参数是否真的兼容，没验证**
- deploy 的 `supported` 集合已经放开 `neoforge`，会在真实使用时立刻暴露问题

这条 ADR 的状态标的是「代码层面」，不是「已验证」。区别很重要——ADR-0015 是跑通了才写的，这一篇不是。

## 顺带修掉的一个 Fabric / Forge 差异

用真实 Forge mod（JEI 6.6 MB）测离线预检时，报了一条假阳性：

```
✗ MISSING_DEPENDENCY  jei 需要前置模组 mezz_config，本地目录里没有
```

JEI 明明自带了 `mezz_config`。查 jar 结构才发现：

```
META-INF/jarjar/mezz_config-1.20.1-forge-0.6.6.jar
```

**Forge 的嵌套机制叫 JarJar，前缀是 `META-INF/jarjar/`；Fabric 的叫 JiJ，前缀是 `META-INF/jars/`。** 两套路径不同，嵌套 jar 里的元数据文件名也不同：

| | 前缀 | 嵌套 jar 内的元数据 |
|---|---|---|
| Fabric JiJ | `META-INF/jars/` | `fabric.mod.json` |
| Forge JarJar | `META-INF/jarjar/` | `META-INF/mods.toml` |

ADR-0013 只处理了前者。现在两个前缀都扫，两种元数据都能读。

修复后同一份实例：`BLOCKED` → `WARN`。

## 顺带发现

**NeoForge 的 maven 在国内很难访问**，而 BMCLAPI 只镜像了 `maven.minecraftforge.net`，没有 `maven.neoforged.net`。这意味着：

- 国内用户装 NeoForge 整合包大概率失败
- 除非有第三方镜像（未调研）

这不是本项目能解决的，但值得在 README 里提一句。

## Consequences

**Positive**

- 一个函数覆盖两种加载器，没有重复代码。
- `installerSpec` 是纯函数，坐标规则可以单测（还没写）。

**Negative**

- 未实测。
- 没有 NeoForge 的版本发现（recommended 接口），必须依赖 mrpack 给版本。
- 国内可达性差，实际使用价值打折。
