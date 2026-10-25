# 0015. Forge：跑官方 installer，不自己解析 install_profile

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0011

## Context

Forge 1.13+ 的安装**不是「下载一堆 jar」**，而是给原版 client jar **打二进制补丁**（binpatches）。`install_profile.json` 里的 `processors` 数组定义了要运行的步骤：解压、合并 srg 映射、应用补丁、重新打包。

两条实现路径：

| | 做法 | 代价 |
|---|---|---|
| A | 自己解析 `install_profile.json`，按 processors 逐个执行 | 要复刻 Forge 的补丁工具链，版本间还会变 |
| B | 下载官方 installer jar，用 java 跑它 | 依赖 java，运行慢（1–3 分钟），但可靠 |

## Decision

**选 B。**

理由很直接：processors 依赖 `forge-installertools` 这类工具 jar，且不同 MC 版本的处理流程有差异。自己实现等于把 Forge 的安装器重写一遍，收益为零——用户不关心补丁是谁打的。

我们只需要它最终产出 `versions/{mc}-forge-{forge}/{mc}-forge-{forge}.json`。

```bash
java -jar forge-installer.jar --installClient <root>
```

`--installClient` 让它走命令行模式而不是弹 GUI。

## 三个坑

### 坑一：installer 要求 `launcher_profiles.json`

第一次跑直接失败：

```
There is no minecraft launcher profile in "D:\...", you need to run the launcher first!
```

这个文件是官方启动器的标记。我们不需要实现它，写个空壳即可：

```json
{ "profiles": {}, "settings": {}, "version": 3 }
```

### 坑二：Forge 的版本目录里只有 .json，没有 .jar

```
versions/1.20.1-forge-47.2.0/
  1.20.1-forge-47.2.0.json     ← 只有这个
```

打补丁后的 client 在 `libraries/net/minecraftforge/forge/{mc}-{forge}/forge-{mc}-{forge}-client.jar`，不在版本目录。

所以 `jarId` 要回退到 `rootVersionId` 的逻辑（ADR-0011 已经做过），但这次是**连回退都不需要**——见坑三。

### 坑三：classpath 里不能有原版 jar

不处理会直接崩：

```
java.lang.module.ResolutionException: Modules _1._20._1 and minecraft
export package net.minecraft.obfuscate to module forge
```

`_1._20._1` 是从 `versions/1.20.1/1.20.1.jar` 自动推导出的模块名。Forge 的 patched client 也是一个 `minecraft` 模块，两者导出同一个包，Java 模块系统直接拒绝。

原因：Forge 1.17+ 用 **BootstrapLauncher**，它靠 `-DlibraryDirectory` 自己扫描组装模块，并用 `-DignoreList` 排除掉 `client-extra`、`forge-*` 这类 jar。我们的 `-cp` 里的原版 jar 不在 ignoreList 里，就成了多余的自动模块。

判定方式：

```ts
export function usesOwnClasspath(version: VersionJson): boolean {
  if (version.mainClass.includes('bootstraplauncher')) return true
  return version.arguments?.jvm?.some(a => typeof a === 'string' && a.includes('-DignoreList')) ?? false
}
```

命中就不把 client jar 放进 classpath，缺失检查也跳过它。

## Consequences

**Positive**

- 一套 installer 流程覆盖 Forge 1.13–1.20.x（NeoForge 大概率也适用，未验证）。
- 装完的 libraries 和 patched client 都由 installer 负责，我们不用维护 maven 坐标。
- 已装过会跳过（检查 version JSON 是否存在），重跑不重复打补丁。

**Negative**

- **依赖 java 才能安装**。`deploy` 因此需要传 `--java`，CLI 会先检测一次。
- installer 运行 1–3 分钟，期间只有粗粒度的日志，进度条做不了。
- installer 会往 root 写 `launcher_profiles.json`，算是对用户目录的污染。
- **没有校验 installer 产物的完整性**——只能相信它。

## 实测

`deploy fixtures/forge-pack.mrpack`（1.20.1 + Forge 47.3.0，空整合包）：

```
→ 原版文件（66 个，已存在跳过）
→ 加载器（installer 下载 + 打补丁）
→ 整合包文件（0 个）
→ overrides（1 个文件）

装好了 1.20.1 + forge 47.3.0
部署后检查  OK
```

耗时 1 分 4 秒。启动：

```
ModLauncher 10.0.9 starting: java version 21.0.4
Launching target 'forgeclient'
```

手动验证 47.2.0 时还看到了完整初始化：

```
Forge mod loading, version 47.2.0, for MC 1.20.1 with MCP 20230612.114412
MinecraftForge v47.2.0 Initialized
```
