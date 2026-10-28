# BlockPilot

AI 可驱动的 Minecraft 启动器**内核**——参考实现。

不是又一个启动器。它想回答一个问题：**当 AI 要替你装游戏、查兼容性、修崩溃时，启动器该长什么样？**

```
core/      纯逻辑，不知道 stdout 存在
  cli/     进程内消费者，渲染成人类可读文本
  mcp/     独立进程，把 OpEvent 转成 MCP 通知
```

不是给玩家用的客户端（没有 GUI），不与 HMCL / Prism 竞争功能，也不做「AI 看日志猜原因」——那条路上已经站了五个人。

## 快速开始

```bash
npm install
node scripts/make-fixture.mjs && node scripts/make-instance-fixture.mjs

npm run preflight -- fixtures/closure.mrpack   # 在线：缺 Sodium，给出可执行的修复计划
npm run preflight -- fixtures/instance-miss    # 离线：只读 jar 元数据，零网络

npm test        # 242 个测试，全部不依赖网络
npm run smoke   # 起真实 MCP 子进程，走 stdio 调一次工具
```

## 前提

- **正版登录要一个自己的 Azure 应用 id**（免费注册一次）：在 portal.azure.com 建「个人账号」应用，开启「允许公共客户端流」，加委托权限 `XboxLive.signin`，然后 `--client-id` 或 `BLOCKPILOT_CLIENT_ID`。第三方不能复用官方启动器的 id——那是冒充。
- **NeoForge 的 maven 在国内被墙**，已内置 `neoforged.forgecdn.net` 镜像（含 installer 重打包），无代理可装；有代理时 `--proxy` 走官方保真度更高。

## 命令

| 命令 | 做什么 |
|---|---|
| `preflight <target>` | 检查它能不能跑。`--json` 给结构化报告 |
| `deploy <pack.mrpack>` | 一条命令装完：原版 → 加载器 → 模组 → overrides，装完自检 |
| `install <target> --mods-dir <dir>` | 把 `plan.installs` 下载落地（`--dry-run` 只看计划） |
| `setup <version>` | 原版文件：client jar + libraries + assetIndex + natives |
| `assets <version>` | 音效/语言/字体（1.20.1 约 621 MB，可不装——只是没声音） |
| `fabric <mc> [--loader <ver>]` | 单独装 Fabric（`deploy` 会自动做） |
| `java` / `java install <major>` | 列出本机 Java / 从 Adoptium 装一个 |
| `login` / `accounts` | 微软账号登录（设备码）/ 列出或删除账号 |
| `launch <version>` | **只生成启动命令**，不启动 |
| `run <version>` | 真的启动，日志落盘到 `<实例>/logs/` |
| `logs` / `diag` | 列出会话日志 / 把崩溃归因到具体模组 |

通用：`--root <dir>`（默认 `%APPDATA%\BlockPilot`）、`--instance`、`--china`（镜像优先）、`--proxy <url>`。

## 能力边界

预检支持三种输入，但**只承诺能承诺的**：

| | `.mrpack` | CurseForge zip | 实例目录 |
|---|---|---|---|
| 模组身份 | Modrinth `projectId` | `projectID`/`fileID` | jar 内 `modId` |
| 依赖检查 | 递归闭包 | 无法（要 API key） | 单层 |
| 网络 | 需要 | 预检不需要 | **不需要** |
| 给出下载地址 | 是 | 否 | 否 |

CF 的 manifest 只有数字 id，没有 URL 和哈希——所以它明确报 `CF_API_REQUIRED`，而不是装懂。详见 [ADR-0021](docs/adr/0021-curseforge-boundary.md)。

`preflight --json` 里的 `plan.installs` 与下载器字段完全对齐（`url` / `fileName` / `size` / `hashes` / `requiredBy`）——这是「检查 → 一键修 → 再检查」的接口，不是建议列表。

<details>
<summary>检查项全集（14 个 code）</summary>

| code | 含义 |
|---|---|
| `VERSION_MISMATCH` / `LOADER_MISMATCH` | 模组不支持这个 MC 版本 / 加载器 |
| `MISSING_DEPENDENCY` | 缺前置（在线模式附可安装版本） |
| `DEPENDENCY_VERSION_MISMATCH` | 已装的版本不满足依赖方声明的范围 |
| `UNSATISFIABLE_DEPENDENCY` | 缺前置，且没有兼容当前版本的可安装版本 |
| `DECLARED_INCOMPATIBLE` / `DEPENDENCY_CYCLE` | 互相声明不兼容 / 闭环依赖 |
| `UNRESOLVED_MOD` / `UNREADABLE_JAR` | 查不到元数据 / jar 读不出元数据，不参与判断 |
| `JAVA_MISSING` | 一个够用的 Java 都没有（blocker） |
| `JAVA_NEWER_ONLY` | 没有精确版本但有更高版本（warning，多数能跑） |
| `JAVA_OLDER_PRESENT` | 同时存在更低版本（info，启动时需指定路径） |
| `UNKNOWN_GAME_VERSION` / `CLOSURE_TRUNCATED` | 目录无版本信息 / 依赖链超出展开上限 |

</details>

## 四个决定成败的判断

**1. 同一个模组有两套身份，且不能互相推导。**
Modrinth 叫 `AANobbMI`，jar 里叫 `sodium`。用文件名猜 `create-1.20.1-0.5.1.jar → Create` 很诱人，但猜错会让用户装上一个完全无关的模组——一次就毁掉预检的可信度。宁可说「不知道装哪个」。见 [ADR-0004](docs/adr/0004-dual-identity.md)。

**2. 镜像给的字节不一定是你要的字节。**
实测过一次：同一个 URL、同一分钟，`curl` 拿到正确的 jar，Node 拿到 HTTP 200 + 一张 2 KB 的 "Service Temporarily Unavailable" HTML。所以**每个源落盘前都比字节数、再比哈希，校验失败等同于下载失败**，直接换下一个源。没有哈希的任务拒绝下载。见 [ADR-0005](docs/adr/0005-download-and-mirrors.md)。

**3. 加载器版本没有自己的 client jar 和 natives。**
Fabric / Forge 的版本目录只有 `.json`，jar 与 natives 要按 **rootId**（父版本）取。另外 `libraryKey` 必须包含 classifier，否则 `org.lwjgl:lwjgl` 和它的 `natives-windows` 变体会互相覆盖——表现是 `NoClassDefFoundError: org/lwjgl/system/MemoryUtil`，而原版能跑、装加载器就崩。见 [ADR-0011](docs/adr/0011-loader-version-merge.md)。

**4. AI 不写盘、不碰凭证。**
MCP 只有两个只读工具。下载要写磁盘、可能几百 MB、还会覆盖用户文件；登录和启动不可回滚。**AI 诊断、人执行**——这才是能交付的边界。见 [ADR-0001](docs/adr/0001-operation-event-stream.md)。

## 对接 AI

```json
{
  "mcpServers": {
    "blockpilot": {
      "command": "node",
      "args": ["--import", "tsx", "D:/BlockPilot/src/mcp/server.ts"]
    }
  }
}
```

构建后换成 `dist/mcp/server.js`。

| 工具 | 作用 |
|---|---|
| `preflight_modpack` | 检查整合包/实例能否运行 |
| `diagnose_crash` | 读崩溃日志，指认到具体模组 |

两个工具的描述里都写了给模型的行为约束：**看到 `unknown` 不许说「没问题」**；**定位不到模组就不许猜名字**——猜错会让用户删掉一个无辜的模组。

## 实测样本

| 场景 | 结果 |
|---|---|
| 原版 1.20.1 | 启动到主菜单（OpenAL + 纹理图集） |
| Fabulously Optimized 6.5.0（50 mod / 1.21.1） | 151 mods loaded |
| Forge 47.3.0 + JEI + AppleSkin | `Launching target 'forgeclient'`，两个 mod 均生效 |
| NeoForge 21.1.265（无代理，走镜像） | ModLauncher 11.0.5，图集全部成功 |
| 崩溃诊断 | 真实日志里指认到 `jei` / `controlify` |
| 正版登录 | 端点与错误映射已验证，**真实登录未实测**（见下） |

## 目录布局

用户只选一次根目录，实例自动派生。`libraries` 与 `assets` 共享——十来个实例就是十几 GB 的重复，而它们是只读的。见 [ADR-0008](docs/adr/0008-directory-layout.md)。

```
<root>/
  libraries/  assets/  versions/<id>/    共享
  instances/<name>/  mods/  natives/      每实例独立
  auth/accounts.json                     明文 0600，见 ADR-0024
```

## 设计文档

24 篇 ADR 在 [`docs/adr/`](docs/adr/)。绕不开的几篇：

| ADR | 讲什么 |
|---|---|
| [0001](docs/adr/0001-operation-event-stream.md) | Operation / OpEvent：core 不打印任何东西 |
| [0002](docs/adr/0002-preflight-first.md) | 为什么先做预检而不是先做启动 |
| [0005](docs/adr/0005-download-and-mirrors.md) | 源是候选列表，哈希是唯一裁判 |
| [0008](docs/adr/0008-directory-layout.md) | 共享库存 + 实例隔离 |
| [0015](docs/adr/0015-forge-installer.md) | Forge 直接跑官方 installer，不自己复刻 |
| [0020](docs/adr/0020-stack-attribution.md) | 栈帧归属：只用事实，两个模组同包就不指认 |
| [0024](docs/adr/0024-microsoft-auth.md) | 设备码登录与令牌刷新 |

术语见 [GLOSSARY.md](GLOSSARY.md)。

## 状态

链路已闭合，全部实测：`.mrpack` → 部署 → 自检 → 启动 → 崩溃 → 日志 → 定位到模组。

**未做**：

- **CurseForge 下载**——要 API key 才能实测，没实测的不发布（预检已支持）
- **真实登录实测**——需要你自备 Azure 应用 id 与正版账号；代码与 22 个测试已就绪
- **Linux/macOS 端到端**——tar.gz 解压器与系统 GNU tar 互通，但没在目标平台跑过
- **版本求解**（刻意不做）——Modrinth 元数据里没有版本范围，硬做等于用假精度骗自己
- **GUI**（刻意不做）——参考实现的价值在协议与分层

## 合规与许可

MIT（见 [LICENSE](LICENSE)）。调用的第三方公益服务有硬性义务：

| 服务 | 要求 | 做法 |
|---|---|---|
| BMCLAPI | UA 以 `${NAME}/${VERSION}` 开头；**必须标明来源** | `USER_AGENT = 'BlockPilot/0.0.1'`；`DownloadSource.credit` 是必填字段，CLI 每次下载后打印「资源来源」 |
| MCIM | 使用前登记 UA | UA 集中在 `src/core/user-agent.ts`，登记见 [issue #12](https://github.com/mcmod-info-mirror/mcim-rust-api/issues/12) |
| Modrinth | 可识别 UA；300 req/min | 统一 UA，元数据 100 个一批 |

`credit` 不是装饰字段——BMCLAPI 要求的「标明来源」必须能被渲染出来，所以它进了类型定义，而不是只写在文档里。
