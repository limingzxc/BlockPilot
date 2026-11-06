# 0027. 原生库按版本 JSON 的约定分目录解压

- **Status**: Accepted
- **Date**: 2026-11-06
- **Deciders**: @liming
- **Depends on**: ADR-0008、ADR-0011

## Context

2026-11-06 的真实用户实测（`docs/testing/2026-11-06-real-user.md`）里，
Fabulously Optimized 14.1.2（MC 26.2 + Fabric 0.20.1）装完第一次启动就死在：

```
Caused by: java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll
	at org.lwjgl.system.Library.loadSystem(Library.java:177)
```

`extractNatives` 把所有原生库解到 `natives/<版本>/` 下：

```
natives/26.2/windows/x64/org/lwjgl/lwjgl.dll
```

但 26.x 的版本 JSON 里，JVM 参数已经改成按用途分目录：

```
-Djava.library.path=${natives_directory}/java
-Djna.tmpdir=${natives_directory}/jna
-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl
-Dio.netty.native.workdir=${natives_directory}/netty
```

`java.library.path` 指到 `natives/26.2/java`——一个不存在的目录，LWJGL 自然找不到 DLL。

1.x 的参数是 `-Djava.library.path=${natives_directory}`（没有子目录），
所以 1.21.1 一直是好的。这个差异只在 26.x 上出现，而且**部署后检查发现不了**：
它只看 jar 里的元数据与依赖，不看运行时能不能加载动态库。

## Decision

1. 判断依据用**版本 JSON 自己写的参数**，不猜版本号：
   `arguments.jvm` 里出现 `${natives_directory}/java` 即视为拆分布局。
   加载器版本经 `inheritsFrom` 合并后仍带着父版本的参数，Forge/NeoForge 同样适用。
2. 拆分布局下按 maven group 分目录：
   - `org.lwjgl:*` → `java/`
   - `net.java.dev.jna:*` → `jna/`
   - `io.netty:*` → `netty/`
   - 其他 → natives 根目录（保守：未知原生库仍放在老位置）
   同时预建 `java/`、`jna/`、`lwjgl/`、`netty/` 四个目录——后三个是运行时
   「自己解压到这里」的临时目录，不存在时会在游戏启动阶段才报错。
3. jar 内的相对路径保持不变（`windows/x64/org/lwjgl/lwjgl.dll`）。
   实测这样能被 LWJGL 的 `SharedLibraryLoader` 找到，不需要拍平成 basename。
4. 旧布局（1.x）行为完全不变。

## Consequences

**Positive**

- 26.x 首次启动可用。实测：删掉 natives 重跑 `deploy`，`run --stop 45` 进入游戏，
  1018 行日志、`Loading 149 mods`、exit 0。
- 判断逻辑是纯函数（`usesSplitNatives` / `nativeSubdir`），可以离线单测，
  不依赖下载任何东西。

**Negative**

- 依赖 Mojang 的参数写法。若将来再改目录名（例如再拆一层），这里要跟着改；
  但至少不会静默错——参数里写什么，我们就往哪里放。
- 未知 group 的原生库仍解到根目录。若某个模组自带原生库并依赖子目录约定，
  需要单独处理（当前真实包里没有这种）。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 按 `javaVersion.majorVersion >= 25` 判断 | Java 版本和原生库布局没有因果关系，只是这次恰好同步变化 |
| 拍平路径，把 DLL 都放到 `java/` 根下 | 会丢掉 `windows/x64` 这层，多架构共存时互相覆盖；实测保持原路径即可工作 |
| 不预建 jna/netty/lwjgl 目录 | JNA 与 Netty 会在运行时往这些目录解压，缺目录时错误出现在游戏阶段，离根因更远 |
| 只改启动参数（把 `${natives_directory}/java` 替换成根目录） | 要改写 Mojang 给的参数，属于「猜」；而且 jna/netty 的临时目录仍然缺 |

## 验证

- 单测 `src/core/setup/natives.test.ts`：拆分布局与旧布局各一条端到端解压，
  外加两条纯函数映射用例。
- 真包：`Fabulously.Optimized-v14.1.2.mrpack` → `deploy` → `run --stop 45` → exit 0。
- 回归：`npm run e2e` T0 15/15、T1 7/7（1.21.1 的旧布局行为未变）。
