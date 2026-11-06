# 0030. 1.12.2 的 mcmod.info 按「展示信息」处理

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @liming
- **Depends on**: ADR-0013、ADR-0025

## Context

装上 RLCraft 2.9.3（1.12.2 + Forge，187 个 jar）后，部署后检查原本只说两条：
`enhancedvisuals 缺 creativecore`、`spartanshields 要求 minecraft [1.13.2]`。
两条都是假的：

- `CreativeCore_v1.10.70_mc1.12.2.jar` 明明在 `mods/` 里，但它的元数据只有 `mcmod.info`，
  而读取器只认 `fabric.mod.json` / `quilt.mod.json` / `mods.toml`——1.12.2 的模组一个都读不出来。
- `SpartanShields` 的 jar 里同时有 `mcmod.info`（`mcversion: 1.12.2`）和一份 1.13 模板残留的
  `META-INF/mods.toml`（`minecraft [1.13.2]`）。旧代码先读 `mods.toml`，于是拿到 1.13 的约束。

补上 `mcmod.info` 解析之后又冒出三类新问题，都是语义没对上：

1. `dependencies: ["required-after:creativecore"]` 被当成一个叫 `required-after:creativecore` 的模组；
   按逗号切还会把 `@[1.0,)` 切成一个叫 `)` 的模组。
2. `mcversion: "1.12"` 被当成精确 `[1.12]`，1.12.2 判不兼容；`"1.12.x"` 同理。
3. `mcversion: "1.9.4"`（ResourceLoader 这种老包忘了改）被当成硬约束，判 BLOCKED。

最关键的实证：RLCraft 里 `WolfArmor` 声明了三个**不存在**的前置（`twilightforest`、
`sophisticatedwolves`、`dogslie`），这个包照样能进游戏。说明 `mcmod.info` 的
`dependencies` / `mcversion` 不是 Forge 的硬依赖——真正生效的是 `@Mod(dependencies=...)`
注解，而那份在字节码里，不在清单里。

## Decision

1. `mcmod.info` 作为第 5 个候选，**按实例版本决定优先级**：
   - 实例 ≤1.12.2：`[fabric, quilt, mcmod.info, neoforge.mods.toml, mods.toml]`
   - 其它：`[fabric, quilt, neoforge.mods.toml, mods.toml, mcmod.info]`
   `scanInstanceDir` 把 `legacy` 传进去。
2. 解析规则：
   - 支持数组、`{modList: []}`、单对象三种形态；
   - `dependencies` 按 Forge 语法解析（`required-after:x@[1.0,)`、`after:x`、`optional:x`），
     不按逗号切；
   - `mcversion` 只填 `mcVersionRange` 供人参考：两段按前缀（`1.12` → `>=1.12 <1.13`），
     带 `x` 先去掉通配段，三段按精确。
3. `mcmod.info` 里的依赖**全部标 non-mandatory**，不参与「缺没缺」判定。
   代价是 1.12.2 的缺依赖检测基本失效——我们读不到注解，猜不如不猜。
4. modId 比较统一小写（Forge 的 modId 不区分大小写，清单里常写 `ForgeEndertech`）；
   `mod_MinecraftForge` 视为虚拟 id（Forge 自己）。

## Consequences

**Positive**

- RLCraft 的部署后检查从 BLOCKED（两条假阳性）变成 OK；176 个 1.12.2 模组能被读出来。
- 1.12.2 的整合包不再满屏「缺少 required-after:xxx」。

**Negative**

- 1.12.2 的缺失依赖只能靠游戏自己报 `MissingModsException`，启动前发现不了。
- `UNREADABLE_JAR` 仍会有若干（无 `mcmod.info` 的 coremod，如 Born In A Barn），
  实例预检因此常常落到 `UNKNOWN`。这是诚实的结果，不是缺陷。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 只读 mcmod.info，忽略 mods.toml | 1.13+ 的包就读不出元数据了；按实例版本选更准确 |
| 把 mcmod.info 依赖当 required | 每个 1.12.2 包都会报一堆假缺失（wolfarmor 就是证据） |
| 用 `mcversion` 生成 minecraft 硬依赖 | ResourceLoader 写着 1.9.4 却能跑，说明它不是硬约束 |
| 解析 class 里的 `@Mod` 注解 | 要引入字节码解析，为一个正在退场的版本不值得 |

## 验证

- `read.test.ts`：mcmod.info 四种形态、`required-after:` 语法、`1.12` 前缀、新旧描述符共存时按实例版本选。
- 真机：RLCraft 176/187 可读，部署后检查 OK；`preflight` 对 1.12.2 实例给出 UNKNOWN（7 个无元数据的 coremod）。
