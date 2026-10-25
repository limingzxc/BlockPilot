# 0004. 两种模组身份：projectId 与 modId

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0002、ADR-0003

## Context

为了支持 `.mrpack` 之外的格式（Prism 实例、裸 `.minecraft`、任何带 `mods/` 的目录），必须先解决一个看起来不起眼、但会决定整个架构的问题：

**同一个模组有两套身份。**

| 身份 | 例子 | 出现在哪 |
|---|---|---|
| Modrinth `projectId` | `AANobbMI` | `.mrpack` 的 CDN 下载 URL 里 |
| jar 内 `modId` | `sodium` | `fabric.mod.json` / `mods.toml` 里 |

它们不能互相推导。`AANobbMI` 和 `sodium` 之间没有算法关系，只能靠查表。

而 `modId` 甚至不能保证唯一——不同作者可能撞名，Forge 生态里历史上出现过。

## Decision

### 1. `ModRef` 同时容纳两种身份，都可选

```ts
interface ModRef {
  projectId?: string   // 在线源侧
  versionId?: string
  modId?: string       // jar 内声明
  source: 'modrinth' | 'curseforge' | 'local'
  fileName: string
}
```

用**有没有 `versionId`** 来判断走哪条链路，而不是看 `source` ——因为一个 mrpack 里也可能混着本地 jar。

### 2. 两条链路，各自完整

| | 在线链路 | 离线链路 |
|---|---|---|
| 输入 | `.mrpack` | 目录（Prism 实例 / 裸 `.minecraft`） |
| 身份 | `projectId` + `versionId` | `modId` |
| 元数据 | Modrinth API | jar 内 `fabric.mod.json` / `mods.toml` / `neoforge.mods.toml` / `quilt.mod.json` |
| 依赖 | 递归闭包（ADR-0003） | 单层检查 |
| 能给出下载地址 | 是 | 否 |
| 网络 | 需要 | 不需要 |

**离线只能查一层**——缺失的模组没有 jar，读不到它自己的依赖，没法递归。这不是偷懒，是信息本身不存在。

### 3. 不做 modId → projectId 的模糊映射

用文件名猜模组（`create-1.20.1-0.5.1.jar` → Create）看起来很诱人，但：
- 命名格式千奇百怪，`create-fabric-0.5.1.jar` 和 `Create-1.20.1-v0.5.1.jar` 都要覆盖
- 猜错的代价很高：把 A 的版本当成 B 的，用户会装上一个完全无关的模组
- 一旦做错一次，整个预检的可信度就没了

宁可说「不知道装哪个」，也不猜。

## Consequences

**Positive**

- 离线模式完全不需要网络，这是「任意格式整合包识别」的技术底座。
- 两种模式共用 `Finding` / `PreflightReport` / `Operation`，消费者不需要区分。
- `.mrpack` 里混入本地 jar 时，在线链路会把它标 `UNRESOLVED_MOD`，不会崩。

**Negative**

- 同一个问题在两种模式下 hint 不一样（一个给版本号，一个只说缺什么），**消费者必须读 `plan` 判断能不能一键修**。
- `modId` 撞名时离线检查会误判「已经装了」。目前无解，只能在文档里说明。
- CurseForge 的 zip 还没支持：它有数字 `projectID`/`fileID`，但解析需要 API key。归到在线链路的变体，等 key 申请下来再做。

## 验证

`fixtures/instance-miss`（Prism 风格目录，只放 iris.jar，不放 sodium.jar）：

```
verdict   BLOCKED
mods      2  (resolved 1, unresolved 1)

✗ MISSING_DEPENDENCY  iris 需要前置模组 sodium，本地目录里没有
  → 本地元数据只提供 modId，没有下载地址；需要联网反查才能给出可安装版本

i UNREADABLE_JAR  1 个 jar 读不出模组元数据，未参与检查
  → not-a-mod.jar
```

全程没有网络请求。`mmc-pack.json` 提供了 1.20.1 + fabric-loader 0.15.11。

## Amendment：`provides` 不是可选字段

实现下载器后，用真实下载的 Sodium jar 跑离线检查，发现它依赖 `fabric-rendering-fluids-v1` 和 `fabric-rendering-data-attachment-v1`。

这两个不是独立模组——它们是 **Fabric API 通过 `fabric.mod.json` 的 `provides` 字段声明的子模块**。没有独立的 jar，但别的模组会依赖它们。

所以 `ModMetadata` 必须有 `provides`，本地检查时把它并入「已提供」集合，否则装了 Fabric API 仍然满屏报缺。

验证：同一个目录，加一个带 `provides` 的 fabric-api stub 之前是 `BLOCKED`（2 个假阳性），之后是 `WARN`（只剩 UNKNOWN_GAME_VERSION）。
