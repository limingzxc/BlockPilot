# 0016. NeoForge：同一套 installer，两套坐标

- **Status**: Accepted（2026-10-25 晚起：**已实测**）
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

- **NeoForge 的版本号不带 MC 前缀**。`21.1.264` 对应 MC 1.21.1，`20.4.237` 对应 1.20.4。
- **Forge 的目录名带 MC 前缀**（`1.20.1-forge-47.2.0`），NeoForge 不带（`neoforge-21.1.264`）。

这两条混用会 404 或者装到一个错的位置。

`recommendedForge()` 只对 Forge 有效——NeoForge 没有 promotions 接口，必须由 mrpack 显式给出 `neoforge` 版本（实际整合包都会给）。

## 实测结果（2026-10-25 晚，经代理）

当初写「未验证」，是因为 `maven.neoforged.net` 直连超时。后来经本机代理（`http://127.0.0.1:1081`）跑通了完整链路：

```
deploy fixtures/neoforge-pack.mrpack   →  装好了 1.21.1 + neoforge 21.1.264
run neoforge-21.1.264                  →  ModLauncher 11.0.5 / NeoForge 21.1.264 (neoforge)
                                          OpenAL initialized / Sound engine started
                                          全部纹理图集创建成功
```

**当初写的坐标规则与实测一致**——installer 生成的版本目录就是 `neoforge-21.1.264`，profile 带 `inheritsFrom: 1.21.1`，主类 `cpw.mods.bootstraplauncher.BootstrapLauncher`，`arguments.jvm` 含 `-DignoreList`。这三点正好都落在为 Forge 建的处理路径上（版本合并、`usesOwnClasspath` 排除原版 jar），没有改动。

### 一个此前不知道的事实

**NeoForge 没有 1.20.1 版本**。maven 上的版本从 `20.2.x`（MC 1.20.2）开始——分叉点就是 1.20.1 的 Forge 47.1.x，但 NeoForge 自己的第一个发布是 1.20.2。想跑 NeoForge 就是 1.20.2+。

### installer 是独立 JVM，代理要单独传

实测第一次 deploy 失败：`net.neoforged:bus:8.0.5` 下载失败。原因两层：

1. **Node 的 fetch 在启动时固化 dispatcher**，`NODE_USE_ENV_PROXY` 必须在进程启动前设置，进程内改 `process.env` 无效（实测验证）。解决：引 undici（零依赖），运行时 `setGlobalDispatcher(new ProxyAgent(...))`。
2. **installer 是 Java 程序，有自己的下载栈**，不继承 Node 的任何设置。要靠 `-Dhttps.proxyHost/-Dhttps.proxyPort` JVM 参数——见 `core/proxy.ts` 的 `javaProxyArgs`。

即使参数都对，**多线程下载在代理下仍会偶发失败**。所以 installer 失败自动重试一次——它自己有缓存，第二次跑会跳过已下载的部分，重试代价很小（实测重试直接通过）。

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

- 国内用户装 NeoForge 整合包需要代理：`blockpilot deploy ... --proxy http://127.0.0.1:1081`
- CLI 会把同一个代理同时传给 Node 的 fetch（元数据、installer 下载）和 installer 的 JVM

## Consequences

**Positive**

- 一个函数覆盖两种加载器，没有重复代码——且坐标规则经实测验证正确
- 代理能力对所有加载器生效，不只是 NeoForge

**Negative**

- 引入了 undici 依赖（零依赖包，只为 ProxyAgent）
- 没有 NeoForge 的版本发现（recommended 接口），必须依赖 mrpack 给版本
- 国内可达性差：没有代理时整条链路不可用
