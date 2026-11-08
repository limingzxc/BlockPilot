# 0035. 老版本（1.6.x / 1.7.10 / 1.12.2）走 Legacy Fabric 与老占位符

- **Status**: Accepted
- **Date**: 2026-11-08
- **Deciders**: @liming
- **Related**: ADR-0031（老式库布局）

## Context

想装 BTWCE（MC 1.6.4 + Legacy Fabric）时，整条链路逐段都不通：

1. `fabric 1.6.4` → `unexpected error: https://meta.fabricmc.net/... HTTP 400`。
   官方 meta 对不支持的版本返回 **400 + 空数组**，被当成普通网络失败抛出，
   用户既不知道「这个版本没有官方 Fabric」，更不知道还有 Legacy Fabric。
2. `setup 1.6.4` 的 natives 一个都没下（ADR-0031 之前的版本），启动报
   `UnsatisfiedLinkError: no lwjgl`——这一条已经修好，现在会下载并解压 6 个 DLL。
3. 启动参数里留着 `${auth_session}` / `${game_assets}`：1.6.x 用的是
   `minecraftArguments` 里的老占位符，plan 只替换现代写法。游戏里能看到
   `(Session ID is ${auth_session})`。
4. Legacy Fabric 的 profile 里，`lwjgl-platform` 只给裸 maven 坐标 + `natives` map。
   裸坐标在 maven 上**不存在**（只有 `-natives-windows` 的 classifier），
   照裸坐标下载必然 404。

## Decision

1. `sources/fabric.ts` 增加 `FABRIC_META_LEGACY`（`meta.legacyfabric.net/v2`，
   结构与官方完全一致）与 `detectFabricFlavor()`：先探官方，空/400 再探 Legacy，
   两套都没有才报 `NO_FABRIC_FOR_VERSION` 并说明「1.6.x/1.7.10/1.12.2 走 Legacy」。
   `--legacy` 可强制。
2. `buildFabricTasks` 认识 `natives` map：按 `name:classifier` 组合 maven 路径下载，
   并返回 `nativeJars`；下载后由 `extractNativeJars` 解压到 `natives/<mc 版本>`
   （不是加载器版本 id——启动参数里的 `java.library.path` 指向原版那个目录）。
3. `plan.ts` 补老占位符：`auth_session = token:<accessToken>:<uuid>`、
   `game_assets = assets/virtual/legacy`。
4. 顺手修一个由 assets 检查引入的误伤：`ASSETS_MISSING` 原来对所有版本都说
   「1.19+ 会崩在标题画面」，1.6.4 零 assets 只影响声音。现在按版本分级：
   1.19+ 零资源 → blocker；更早 → warning，提示文案也换掉。

## Consequences

- 1.6.4 + Legacy Fabric 实测：11 个库、6 个原生库解压、启动跑满 45 s，
  日志里 `Loading Minecraft 1.6.4 with Fabric Loader 0.20.1`、
  `Session ID is token:0:000…`（占位符已替换）。
- 遗留：`game_assets` 指向 `assets/virtual/legacy` 但**没有把 objects 展开成散装目录**，
  所以老版本仍然没声音、缺图标（日志里的 `IIOException: Can't read input file!`）。
  这不影响启动，属于后续要做的一步（legacy virtual assets）。
- `detectFabricFlavor` 会把网络失败也当成「不支持」，退到 Legacy 再失败才报错；
  代价是多一次请求，换来的是不再把 400 抛成 unexpected error。
