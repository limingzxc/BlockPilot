# 0002. 第一个垂直切片：启动前预检

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0001

## Context

「AI 读崩溃日志」这一格已经被占满了：小怕（苦力怕论坛官方，234 万会员渠道）、Loomie、MCDoctor.ai、scope-launcher（二进制 bisect 精确定位）、HMCL-AE。学术侧 BugCraft（ASE 2025）在 GPT-4.1 下复现崩溃的成功率是 34.9%。再做一个「崩了之后帮你分析」的产品，是在挤一条已经站满人的窄路。

反过来看，**没有任何一个产品在启动之前告诉用户「这套东西跑不起来」**。所有方案都是崩溃后补救。

这不是因为大家没想到，而是因为它难：需要把模组的元数据变成可计算的约束，再判断可满足性——这是 CSP 问题，不是 prompting 问题。

而难，正是参考实现该做的事。

## Decision

### 1. 预检是只读的

第一版预检**不下载游戏、不启动进程、不碰账户**。输入是一个实例或整合包，输出是一份结构化报告。这保证：

- 零风险（不会写坏用户的 .minecraft）
- 可离线测试（fixture 驱动）
- 可被任何消费者调用（CLI / MCP / 未来的 GUI）

### 2. 确定性核心，LLM 只在两端

```
混乱输入 ──[LLM: 结构化]──▶ Instance ──[确定性求解]──▶ Report ──[LLM: 人话]──▶ 用户
```

- **中间是纯逻辑**：依赖闭包、版本约束、加载器匹配、Java 版本下限。同样的输入永远得到同样的输出，可单元测试。
- **前端是 LLM**：把 rar / 7z / 裸文件夹 / CurseForge zip / 一句自然语言变成 `Instance`。这是「任意格式整合包识别」落地的位置。
- **后端是 LLM**：把 `{ code: 'MISSING_DEPENDENCY', subject: 'create@0.5.1' }` 翻译成「你缺 Create 0.5.1，它被 23 个模组依赖」。

**这条边界是本项目最重要的一条**：求解绝不交给模型。模型的幻觉在「推荐模组」里只是 annoying，在「告诉用户能跑」里是致命的。

### 3. 第一版只做「检查」，不做「求解」

完整 CSP 求解（找最小冲突集、给替代版本建议）留到第二版。第一版做三件事：

| 检查 | 实现 | 输出 |
|---|---|---|
| **约束匹配** | 每个模组的 `game_versions` 是否含实例版本；`loaders` 是否含实例加载器 | `VERSION_MISMATCH` / `LOADER_MISMATCH` |
| **依赖闭包** | 从初始集合出发，递归收集 `required` 依赖，报告未被满足的 | `MISSING_DEPENDENCY` |
| **硬冲突** | `breaks` / `incompatible` 声明中，两侧同时存在的 | `DECLARED_INCOMPATIBLE` |

再补三条不依赖求解的启发式（标为 `warning`，不阻塞）：

- 同类模组重复（两个优化模组、两个小地图）
- 客户端/服务端模组混装
- Java 大版本与 MC 版本不匹配（1.16.5 及以下 → 8；1.17–1.20.4 → 17；1.20.5+ → 21）

### 4. 报告是数据，不是文本

```ts
export type Severity = 'blocker' | 'warning' | 'info'

export interface Finding {
  readonly severity: Severity
  readonly code: string        // 稳定的机器码，供 AI 和测试使用
  readonly message: string     // 默认渲染文案，可被 LLM 重写
  readonly subject?: string    // 出问题的模组/文件
  readonly hint?: string       // 建议动作
}

export interface PreflightReport {
  readonly verdict: 'ok' | 'warn' | 'blocked' | 'unknown'
  readonly findings: readonly Finding[]
  readonly stats: { mods: number; resolved: number; unresolved: number }
  readonly generatedAt: string
}
```

`code` 必须稳定——它是 LLM 的解释锚点，也是回归测试的断言对象。文案可以改，code 不能改。

### 5. 第一个可跑的东西：读 `.mrpack`

`.mrpack` 有公开规范（`modrinth.index.json`，含 `files[]` + `dependencies`），是唯一零门槛的入口。CDN 下载 URL 形如 `cdn.modrinth.com/data/{projectId}/versions/{versionId}/{file}`，可以直接从 URL 解析出身份，不需要额外索引。

第一版 CLI：

```
blockpilot preflight ./SomePack.mrpack
```

输出人类可读报告 + `--json` 输出结构化结果。

## Consequences

**Positive**

- 第一个切片完全不写用户的磁盘，可以放心让人在真实机器上跑。
- 求解器是纯函数，可以被单独测试、单独发布、被别的启动器直接引用。
- 「任意格式整合包识别」变成预检的输入适配器，不需要独立设计——只需不断加 parser。
- 报告里的 `code` 会逐渐长成一套**模组兼容性诊断码表**，这是可以独立开源、独立被消费的资产。

**Negative**

- 第一版只能回答「有没有问题」，不能回答「怎么修」——后者需要求解，工作量是前者的 3 倍。
- 依赖 Modrinth 元数据。CurseForge 的整合包需要 API key，第一版不支持，要在文档里明确说明。
- 启发式规则（同类重复、客户端/服务端混装）会误报，必须标 `warning` 而不是 `blocker`，否则会毁掉可信度。

## 为什么不是崩溃分析

| | 崩溃分析 | 启动前预检 |
|---|---|---|
| 竞品 | 5 家，含 234 万会员渠道的官方产品 | 0 |
| 数据依赖 | 需要真实崩溃样本，冷启动没有数据 | 只需要模组元数据，Modrinth 免费全量可得 |
| 失败代价 | 修不好只是没帮上忙 | 误报「能跑」会让用户白等一次启动 |
| 可测试性 | 差（日志千奇百怪） | 好（约束是确定的，可写断言） |

崩溃分析应该作为**预检的补充**存在：预检说 ok 但实际崩了，那次崩溃就成为预检规则的一条新用例。这是一个会自我变强的闭环。
