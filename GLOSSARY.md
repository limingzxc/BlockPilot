# GLOSSARY

本文件定义 BlockPilot 的领域词汇。写 issue、测试名、重构提案时用这里的词，不要用同义词。

## 领域

**Instance（实例）**
一个独立的游戏环境：MC 版本 + 加载器 + 模组集合 + 配置。对应磁盘上的一个目录。用 `Instance`，不用「游戏」「客户端」「配置」。

**Instance identity（实例身份）**
`<实例>/mmc-pack.json` 里的 MC 版本与 Loader。读写都走 `core/instance/identity.ts`：
格式、Loader↔uid 表、合并规则只有一份。`scanInstanceDir` 通过它发现身份，不再要求调用方先告诉它。

**Loader（加载器）**
Fabric / Forge / NeoForge / Quilt 之一。用 `Loader`，不用「mod 加载器」「引擎」。

**Loader install（加载器安装）**
「把某个 Loader 装进 Instance」的唯一 interface：`createLoaderInstall`。结果统一为
`versionId` / `loaderVersion` / `versionJsonPath` / `failed`，各加载器特有的计数放在
`detail`。分派由 `core/setup/loader.ts` 的加载器表决定，Fabric 与 Quilt 共用
`core/setup/profile.ts` 的实现。用 `Loader install`，不用「装加载器流程」。

**Modpack（整合包）**
可分发的 Instance 快照，包含清单和覆盖文件。格式有 `.mrpack`、CurseForge `manifest.json`、MultiMC `mmc-pack.json` 等。用 `Modpack`，不用「整合」「包」。

**Preflight（预检）**
启动之前的静态检查。不下载、不启动、不登录。产出 `PreflightReport`。用 `Preflight`，不用「检查」「体检」。

**Finding（发现项）**
预检报告里的一条结论。有 `severity`、稳定的机器码 `code`、默认文案 `message`、可选的 `subject` 和 `hint`。

**Constraint（约束）**
模组对自身运行条件的声明：支持哪些 MC 版本、哪些 Loader、依赖谁、与谁冲突。

**Dependency closure（依赖闭包）**
从初始模组集合出发，沿 `required` 依赖递归展开得到的完整集合。第一版只做这个，不做完整求解。

**Mirror（镜像源）**
官方下载源的替代端点。约定是**路径与官方 100% 兼容、只替换 host 前缀**（BMCLAPI 的规则）。用 `Mirror`，不用「加速源」「CDN」。

**Source（内容源）**
模组/整合包的元数据来源：Modrinth、CurseForge、本地文件。用 `Source`。

**ProjectId（项目标识）**
在线内容源侧的稳定 ID，如 Modrinth 的 `AANobbMI`。只在有网络元数据时才有。

**ModId（模组标识）**
jar 内声明的 ID，如 `sodium`、`fabric-api`。本地 jar 只有这个。**它和 ProjectId 不能互相推导**，见 ADR-0004。

## 架构

**Operation（操作）**
core 暴露的最小可执行单元。必须可取消、可重入、可观察。唯一入口是 `run(signal): AsyncIterable<OpEvent>`。

**OpEvent（操作事件）**
Operation 的唯一输出形式。core 内不允许直接写 stdout——所有状态变化必须先成为事件。

**Consumer（消费者）**
订阅 OpEvent 的外壳。目前有 `cli` 和 `mcp`，未来的 `gui` 是第三个。Consumer 之间不共享代码，只共享 core。

**Renderer（渲染器）**
Consumer 内部的 module：接收 `OpEvent` 流，产出人类/AI 可读的输出，并把它映射成退出码。缺省渲染（进度单行刷新、failed 红字）在 `cli/ui.ts` 的 `consume` 里实现一次；下载类事件（进度 + 成功/缓存/失败）走 `cli/render/download.ts`，命令只声明事件码族。

**Operation forward（步骤转发）**
把一个子 Operation 的事件接进父 Operation 的契约：log/progress 原样转发、`result` 交给回调、`done` 丢弃、`failed` 转发并中止整体。见 `deploy.ts` 的 `forwardStep`。

**Download batch（下载批）**
一组 `DownloadTask` 的并发执行 module：输入 task 流与事件码前缀，产出计数、ok/cached/failed 事件、进度，结束返回汇总（含逐文件 `DownloadOutcome`）。需要逐文件结果的调用方（`install`）也走它，不再自己实现下载池。见 `download/batch.ts`。

**Report assembly（报告装配）**
把证据折成 `PreflightReport` 的唯一 module：checker 集合（Java / 内存 / 本地依赖 / assets）、`stats` 算法、`verdict` 的 unknown 规则只在这里。目录、在线、CurseForge 三种证据来源都汇到 `preflightFrom`；`deploy` 的部署后自检也走同一条路径，结论不会分叉。见 `preflight/report.ts`。

**Command declaration（子命令声明）**
一条子命令的 flag 形状、取值占位符与帮助，写在 `defineCommand` 一处；`validateFlags`、`--help`、分发都从它派生。见 `cli/commands.ts`。

**Command context（命令上下文）**
handler 的全部输入：`argv` / `signal` / `proxy` / `root` / `instance` / `layout` / `sources` / `china`。`layout` 与 `sources` 惰性求值，用不到它们的子命令不付代价。

**Pack reader（整合包读取）**
「路径 → Instance + 这个格式能做什么」的 module。能力声明用 `givesDownloadUrls` / `checksMods` 表达，消费者据此决定能做什么检查，而不是各自判断格式。见 `preflight/read-pack.ts`。

**Auth chain（认证链）**
微软账号 → Xbox Live → XSTS → Minecraft 的四段令牌交换。每段的令牌只对下一段有效，不能复用也不能跳过。见 `core/auth/xbox.ts`。

**Device code（设备码）**
OAuth 的一种授权方式：服务端给出一组 `user_code` + `verification_uri`，用户在任意设备的浏览器里输入，程序轮询 `device_code` 直到完成。密码不经过调用方。

**Account store（账号存档）**
`<root>/auth/accounts.json`。只存「够启动 + 够刷新」的字段（uuid/name/accessToken/refreshToken/clientId）。明文、0600、原子写。见 ADR-0024。

**Capability group（能力组）**
MCP 暴露的工具分组，六组：`instance` / `package` / `config` / `repository` / `account` / `loader`。

**Forbidden operation（禁区操作）**
刻意不暴露给 AI 的操作：**启动游戏（run）** 与 **账户授权（OAuth）**。理由：不可幂等、不可回滚。装错模组能删，用你的账号启动一次游戏撤不回来。

## 避免的说法

| 不要用 | 用 |
|---|---|
| 游戏客户端 / 客户端 | Instance |
| 引擎 / mod loader | Loader |
| 整合 / 包 | Modpack |
| 检测 / 校验 | Preflight |
| 加速源 / CDN | Mirror |
| 插件 / 模块（指 MCP 工具时） | Capability group |
