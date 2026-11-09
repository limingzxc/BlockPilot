# 0041. 实例 lock.json 与 verify

- **Status**: Accepted
- **Date**: 2026-11-09
- **Deciders**: @liming
- **Related**: ADR-0001（状态落盘）、ADR-0005（哈希是唯一裁判）、ADR-0012（重跑安全）、ADR-0040（本次边界）

## Context

ADR-0001 说「实例配置、任务记录、已装内容清单必须是磁盘上的持久状态」，  
但在此之前只有 `mmc-pack.json` 这个版本标记。它能回答「这是什么版本」，  
不能回答：

- 这个实例里哪些文件是 `deploy` 装的？
- 上次部署是走完了，还是死在半路？
- 文件还在不在、有没有被改过？

后果很具体：`verify` 无从做起；`update` 不知道每个文件来自哪个 URL；  
半成品实例只能靠人肉比对 `mods/` 的数量。

## Decision

### 1. 文件与位置

`<实例>/.blockpilot/lock.json`，原子写（`.tmp` + rename），由 `deploy` 在  
部署后自检之后写入。schema：

```json
{
  "version": 1,
  "pack": { "name": "...", "kind": "mrpack | curseforge", "file": "..." },
  "target": { "gameVersion": "1.20.1", "loader": { "kind": "fabric", "version": "..." } },
  "complete": true,
  "updatedAt": "2026-11-09T05:00:00.000Z",
  "files": [
    { "path": "mods/a.jar", "sha1": "...", "sha512": "...", "size": 123, "url": "https://..." }
  ]
}
```

- `path` 是相对实例根的 posix 路径：换一台机器、换一个根目录都能读。
- 只记录**有哈希**的清单文件（mrpack / CF 任务）。overrides 里的配置没有  
  可信哈希，记进来只会让 `verify` 误报。
- `complete` 只看「这次部署有没有失败项」。preflight 判 `blocked` 是  
  「装完跑不起来」，不是「没装完」，两件事不能混。

### 2. `verify` 子命令

`blockpilot verify [--root] [--instance] [--json]`：

- 逐个核对 lock 里的文件：`missing` / `mismatch` / `unreadable` / `no-hash`
- 退出码：`0` 全部一致且上次部署完整；`2` 有问题或 `complete: false`；`1` 参数/环境错误
- 没有 lock 报 `LOCK_NOT_FOUND`；lock 坏了报 `LOCK_CORRUPT`（不是「没有清单」）

`verify` 不联网、不重新解析整合包：它只相信 lock 与磁盘。

### 3. 与 deploy 的关系

- 写 lock 失败只发 `deploy.lock_failed` warning，不让本次安装失败——  
  但用户必须知道 `verify` / `update` 会缺前置。
- 重跑 deploy 会重写 lock；`complete: false` 的旧清单会被新结果覆盖。
- `overrides` 解压失败时 `complete: false`，因为实例确实缺文件。

## Consequences

**Positive**

- `verify` 可以离线回答「这个实例还完整吗」，不用重算 3000 个 assets 的哈希。
- 半成品检测有了事实依据：`complete: false` 比「模组数量对不上」可靠。
- `update` 的输入已经就位：每个文件的 URL、哈希、目标版本都在 lock 里。

**Negative**

- 多一个需要维护的 schema；版本不匹配时要报 `LOCK_CORRUPT` 并提示重跑 deploy。
- 只覆盖清单文件，overrides 的完整性仍然只能靠 preflight。
- 手工装出来的实例没有 lock，`verify` 只能报「没有清单」。

## Alternatives considered

| 方案                        | 否决理由                             |
| ------------------------- | -------------------------------- |
| 把 lock 写进 `mmc-pack.json` | 那是 MultiMC/Prism 的格式，塞私有字段会破坏互操作 |
| 记录 overrides 的哈希          | 解压时没有可信来源哈希，只能自算，验证不了「来源正确」      |
| `verify` 重新读整合包比对         | 需要用户手里还有原包；lock 的意义就是脱离原包        |

## 验证

- `src/core/instance/lock.test.ts`：roundtrip、相对路径、缺失/哈希不符、未完成、无清单、损坏
- `src/core/deploy.test.ts`：部署成功后 lock 存在、`complete: true`、pack/target 正确
- `scripts/e2e.ts` E2E-015：CLI `verify` 正常退出 0；篡改文件后退出 2 且 `reason: mismatch`

## 后续：`update` 检查与 `--apply`

- **检查**：对 lock 里带 `projectId/versionId` 且 `source=modrinth` 的条目，
  用 `DependencyResolver.resolve` 反查「当前 MC + 加载器下最新兼容版本」。
  `LockedFile` 因此增加 `projectId/versionId/source`（mrpack 从 CDN 地址解析，
  CF 从 `CfFileInfo` 取）。
- **应用**：`update --apply` 顺序固定为「下载并校验新文件 → 删除旧文件 → 重写 lock」。
  任一步失败都保留旧文件与旧 lock；文件名变化时检查是否与其他 lock 条目冲突。
- **CurseForge**：走 `getLatestFile` 反查（有 key 走官方，没有走 MCIM 镜像）；
  比较 fileId，应用时同样先下载校验再替换。

## 不做

- **lock 里记录 overrides**：见上表。
- **自动修复**：`verify` 只报告，不下载。修复由人确认后跑 `update --apply` 或重跑 deploy。
- **更新加载器**：`update --loader` 支持 Fabric / Quilt / Forge / NeoForge。
  NeoForge 没有 promotions，从 `maven-metadata.xml` 按 MC 版本前缀取最高构建。
