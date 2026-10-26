# 0023. 架构评审：七个加深机会

- **Status**: Accepted
- **Date**: 2026-10-26
- **Deciders**: @liming
- **Depends on**: ADR-0001

## Context

项目功能已经完整（三种加载器、三种输入、全链路实测），但复杂度堆在了错误的位置。
一次基于 git 热点（`cli/index.ts` 被 11/17 次提交触碰）的架构评审找出了七处摩擦，
全部有代码证据：

| # | 摩擦 | 证据 |
|---|---|---|
| 1 | OpEvent → 输出之间没有 adapter 位置 | CLI 12 份 + MCP 2 份同构消费循环；`collect()` 零调用 |
| 2 | deploy 强转子步骤的 result | 3 份同构转发循环、2 处 `as { versionId }` |
| 3 | 下载池样板复制 4 份 | deploy / fabric / assets / vanilla 各 ~22 行 |
| 4 | 「挑 Java」用例只在 CLI 里 | 3 份实现且已漂移（runDeploy 策略不同） |
| 5 | 测试全部绕过 Operation interface | deploy（最复杂编排）删掉没有测试会红 |
| 6 | Modpack 格式判断写两遍 | preflight 三分支 + deploy 各一份；CF 两个事件码 |
| 7 | ModIndex 生命周期锁死在单次调用 | 每次 diag 全量扫 jar（635ms/46 模组） |

## Decision

七个全部修复。核心判断：**加深 = 把复杂度从调用点搬回 module 内部，而不是消灭它。**

### 1. Renderer（`cli/ui.ts`）

`consume(op, ui, signal)` 承担循环骨架：进度缺省单行刷新、log 缺省 `· code`、
failed 缺省红字+hint、result 必填并映射退出码。12 个 runXxx 只声明差异。

ADR-0001 说 consumer 之间不共享代码——这是 consumer **内部**的 module，
MCP 侧将来自己长出同名 seam，互不共享，不违反。

### 2. Operation forward（`deploy.ts` 的 `forwardStep`）

转发契约只写一次，用 `yield*` 的返回值表达「是否失败」。新增
`LoaderStepResult`（versionId 即可启动版本）作为 loader 步骤的接口，
deploy 不再认识 fabric/forge 的其余字段。`DeployDeps` 注入点让编排可离线测试。

### 3. Download batch（`download/batch.ts`）

`runDownloadBatch` 承接「task 流 + 事件码前缀 → 计数与事件」。四处调用点各删
约 25 行；assets 用 `logPerFile: false` 与 `progressEvery` 表达它的特殊性。

### 4. Java 选择用例（`core/java/select.ts`）

`selectJava` 组合 detectJava / pickJava / requiredJavaMajor；`chooseJava` 是纯函数。
三种策略（精确 / 更高 / 按最高兜底）收敛在一个 implementation，漂移被 interface 挡住。

### 5. Interface 级测试

`collect()` 从零调用变成被测试真实使用的 adapter。新增 27 个用例：
deploy（注入假步骤）、diagnose（真日志 + 真 jar）、launcher（`process.execPath -e`
当假 java，真进程真退出码）。测试现在穿过 Operation interface，与 consumer 走同一个 seam。

### 6. Pack reader（`preflight/read-pack.ts`）

`readPackFile(path)` 返回 `{ kind, instance, ability: { givesDownloadUrls, checksMods }, mrpackIndex? }`。
preflight 与 deploy 共用；CF 事件码统一为 `CF_API_REQUIRED`。
目录扫描刻意不进来——它返回 ScannedMod 明细，是离线检查的输入，不是整合包文件。

### 7. ModIndex 作为参数

`createDiagnose({ index })` 接受预建索引，生命周期交给调用方。
缺省仍是每次全量扫——小索引不值得在 module 内部藏缓存。

## Consequences

**Positive**

- `cli/index.ts` 1200 → 1099 行且只剩 renderer；新增子命令的成本是一次 `consume` 调用
- core 内部出现三个有名字的 module（forward / batch / pack reader），新加载器或新格式的接入点明确
- 测试数 184 → 208，覆盖了此前零验证的三处编排
- 消除两个机器码并存（CF_API_REQUIRED / CF_API_KEY_REQUIRED）

**Negative**

- 多了一层 `consume` 间接；调试渲染问题时要多看一个文件
- `DeployDeps` 与 `index` 注入点增加了 interface 面积——但每个都有真实调用方
  （测试 / 未来的 MCP 缓存），不是假想 seam

## 不做

- **把 MCP 也接到同一个 Renderer**：ADR-0001 的边界仍然成立，两个 consumer 的
  输出形态本来就不同（文本 vs 结构化），共享只会让两边互相迁就
- **给 ModIndex 内置缓存**：缓存失效逻辑比省下的 635ms 更贵；参数化后由调用方决定
