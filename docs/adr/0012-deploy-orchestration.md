# 0012. deploy：把五个步骤串成一条命令

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0008、ADR-0009、ADR-0011

## Context

`.mrpack` 到「能启动」中间有五步：原版文件、加载器、整合包模组、overrides、assets。每一步都已经有了独立的 Operation，但它们各自要求用户先知道版本号、先选 loader 版本。

用户拿到的只是一个 `xxx.mrpack`，里面什么都有：`dependencies` 直接给出 `minecraft` 和 `fabric-loader` 的版本。

## Decision

### 1. 一个 Operation 编排，子步骤事件原样转发

```ts
for await (const ev of createVanillaSetup({...}).run(signal)) {
  if (ev.type === 'result') vanillaOk = true
  else if (ev.type === 'failed') return
  else if (ev.type !== 'done') yield ev
}
```

关键点：**过滤掉子 Operation 的 `result` 和 `done`**。

- `result` 一个 Operation 只能 yield 一次，deploy 自己还要返回结果，混在一起消费者分不清
- `done` 表示「本 Operation 结束」，子步骤结束不代表整体结束

好处是子 Operation 完全不需要知道自己在被编排——`createVanillaSetup` 既可以直接跑，也可以被 deploy 调。

### 2. 服务端专用的文件不装

mrpack 的 `env` 语义：

```json
{ "client": "unsupported", "server": "required" }
```

这类文件装进客户端轻则浪费空间，重则因为依赖服务端 API 直接崩。`buildPackTasks` 里过滤掉。

### 3. overrides 的覆盖顺序

`overrides/` 和 `client-overrides/` 都解压到实例根。后者优先——用排序保证「先写 overrides，再写 client-overrides」，不需要显式覆盖逻辑。

### 4. 不支持的加载器明确报错，不静默降级

```ts
yield Op.failed('UNSUPPORTED_LOADER', `这个整合包用的是 ${kind} ${version}`, '目前只支持 Fabric…')
```

静默回退到原版是最糟的选择：用户会以为装好了，然后发现所有 mod 都没生效。

## Consequences

**Positive**

- 一条命令从 `.mrpack` 到可启动，`deploy` 结束后直接打印 `run` 命令。
- assets 刻意不在 deploy 里——621 MB 会让人以为卡住了，留给显式的 `assets` 命令。
- 重跑是安全的：每一步都会校验并跳过已存在的文件。

**Negative**

- **不校验加载器版本与 mod 的兼容性**。实测踩到：fabric-api 0.92.12 要求 loader ≥ 0.16.10，而 mrpack 写的是 0.15.11——游戏启动时才报 `HARD_DEP`，错误信息在千行日志里。
- 只支持 Fabric。Forge 需要跑 installer jar，是完全不同的机制。
- overrides 里的文件不参与校验（它们没有哈希）。
- 没有回滚：装到一半失败会留下半成品实例。

## 实测

```
BlockPilot Real Fixture
→ 原版文件（66 个，全部已存在跳过）
→ 加载器（8 个库）
→ 整合包文件（sodium + fabric-api，真下载）
→ overrides（2 个文件）

装好了 1.20.1 + fabric 0.16.14
模组 2 个（下载 2 / 跳过 0 失败 0）
```

启动后：

```
Loading Minecraft 1.20.1 with Fabric Loader 0.16.14
Loading 59 mods:
  - fabric-api 0.92.12+1.20.1
     |-- fabric-api-base 0.4.32+1802ada577
     ...
  - sodium 0.5.13+mc1.20.1
Loaded configuration file for Sodium: 42 options available
```

59 个是因为 Fabric API 自带 57 个子模块，实际只装了 2 个 jar。

**下一步该做的**：deploy 完成后自动跑一次离线预检，把 `HARD_DEP` 这类问题在启动前暴露出来。
