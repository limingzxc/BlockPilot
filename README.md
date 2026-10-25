# BlockPilot

AI 可驱动的 Minecraft 启动器**内核**——参考实现。

不是又一个启动器。这个仓库想回答一个具体问题：**当 AI 要替你装游戏、查兼容性、修崩溃时，启动器该长什么样？**

## 不是什么

- 不是给玩家用的客户端（第一版没有 GUI）
- 不与 HMCL / Prism / Pandora 竞争功能
- 不做「AI 看日志猜原因」——那条路上已经站了五个人

## 是什么

一个把「操作」和「界面」彻底分开的 core。CLI 和 MCP server 是它的两个消费者，未来的 GUI 会是第三个。

```
core/          纯逻辑。不知道 stdout 存在
  ├── cli/     进程内消费者，渲染成人类可读文本
  └── mcp/     独立进程，把 OpEvent 转成 MCP 进度通知
      └── gui/ （未来）第三个消费者，core 一行不改
```

## 快速开始

```bash
npm install
node scripts/make-fixture.mjs
node scripts/make-instance-fixture.mjs

npm run preflight -- fixtures/closure.mrpack   # 在线：缺 Sodium，给修复计划
npm run preflight -- fixtures/instance-miss    # 离线：读 jar 元数据，发现缺 sodium

# 真的把修复计划下载下来
npx tsx src/cli/index.ts install fixtures/closure.mrpack --mods-dir /tmp/mods
npx tsx src/cli/index.ts install fixtures/closure.mrpack --mods-dir /tmp/mods --dry-run
```

输出：

```
BlockPilot preflight

  verdict   UNKNOWN
  mods      3  (resolved 1, unresolved 2)

  i UNRESOLVED_MOD  无法获取 mods/broken-id.jar 的元数据，该模组未参与检查
    → 内容源未返回该版本，可能已下架
```

`--json` 输出结构化报告，供 AI 或上层应用消费。

```bash
npm test        # 确定性核心的单元测试，不依赖网络
npm run build   # tsc
npm run smoke   # 起一个真实 MCP 子进程，走 stdio 协议调一次工具
```

## 接进 AI 客户端

MCP server 把同一个 core 暴露成工具。开发期直接指向源码：

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

构建后换成 `{"command": "node", "args": ["D:/BlockPilot/dist/mcp/server.js"]}`。

当前只暴露一个工具 `preflight_modpack`。它的描述里写了一条给模型的行为约束：**看到 `unknown` 不许说「没问题」**——有模组没校验过时，结论就是不可信。

`preflight_modpack` 属于 `diagnose` 组。完整的六组划分见 ADR-0001。

**`install` 刻意没有暴露给 AI。** 下载要写磁盘、可能几百 MB、还会覆盖用户已有的文件。参考实现应该展示「AI 诊断、人执行」这条边界，而不是让模型直接动手。报告里的 `plan` 已经足够让上层应用在用户确认后调用后者。

## 第一个能力：启动前预检

在启动之前判断一套模组跑不跑得起来——不下载、不启动、不登录。

**支持两种输入，两条链路：**

| | `.mrpack` 文件 | 实例目录 |
|---|---|---|
| 身份 | Modrinth `projectId` | jar 内 `modId` |
| 元数据 | Modrinth API | `fabric.mod.json` / `mods.toml` / `neoforge.mods.toml` / `quilt.mod.json` |
| 依赖 | 递归闭包 | 单层检查 |
| 网络 | 需要 | **不需要** |
| 能给出下载地址 | 是（`plan.installs`） | 否（`plan.manual`） |

同一个模组有 `projectId`（`AANobbMI`）和 `modId`（`sodium`）两套身份，它们不能互相推导——这是 ADR-0004 的全部内容。

检查项：

| code | 含义 |
|---|---|
| `VERSION_MISMATCH` | 模组不支持这个 MC 版本 |
| `LOADER_MISMATCH` | 模组不支持这个加载器 |
| `MISSING_DEPENDENCY` | 缺必需的前置模组（在线模式会附可安装版本） |
| `DEPENDENCY_VERSION_MISMATCH` | 已装模组或加载器的版本不满足依赖方声明的范围 |
| `UNSATISFIABLE_DEPENDENCY` | 缺前置，但找不到兼容当前版本与加载器的可用版本 |
| `DECLARED_INCOMPATIBLE` | 两个模组互相声明不兼容 |
| `DEPENDENCY_CYCLE` | 需要新装的部分里有闭环依赖 |
| `UNRESOLVED_MOD` | 查不到元数据，不参与判断 |
| `UNREADABLE_JAR` | 目录里的 jar 读不出模组元数据 |
| `UNKNOWN_GAME_VERSION` | 目录里没有版本信息 |
| `JAVA_MISSING` | 一个够用的 Java 都没有（blocker） |
| `JAVA_NEWER_ONLY` | 没有精确版本但有更高版本（warning，多数能跑） |
| `JAVA_OLDER_PRESENT` | 有精确版本，同时存在更低版本（info，启动时需指定路径） |
| `CLOSURE_TRUNCATED` | 依赖链超出展开上限，报告不完整 |

Java 检查**独立于在线/离线模式**，两条链路都跑。检测方式是起进程读 `-XshowSettings:properties`，不是读注册表——绿色版 JDK 也能发现。见 [ADR-0006](docs/adr/0006-java-detection.md)。

```bash
npx tsx src/cli/index.ts java                 # 列出本机可用的 Java
npx tsx src/cli/index.ts java install 21      # 没装就从 Adoptium 装一个
```

`java install` 下载 Temurin JRE（带 sha256 校验）、解压到 `<root>/java`，装完立刻探测验证版本。之后 `run` / `launch` / `deploy` 会**优先用它**，而不是系统里那个——用户明确装的东西不该被别的软件带来的覆盖。见 [ADR-0017](docs/adr/0017-java-auto-install.md)。

目前只支持 Windows（Adoptium 对它给 zip；Linux/macOS 给 tar.gz，还没做）。

## 目录布局

用户只选一次根目录，实例自动派生（见 [ADR-0008](docs/adr/0008-directory-layout.md)）：

```
<root>/                         --root，默认 %APPDATA%\BlockPilot
  libraries/                    所有实例共享（几百 MB）
  assets/                       所有实例共享（1–2 GB）
  versions/<id>/<id>.jar        原版 client jar
  instances/<name>/             每个实例独立
    natives/<id>/               解压出来的原生库
    mods/
```

**不把 `assets` 复制到每个实例**——十来个实例就是十几 GB 的重复。共享的是只读资源，隔离的是会被改的东西。

```bash
npx tsx src/cli/index.ts setup  1.20.1 --root D:/mc
npx tsx src/cli/index.ts assets 1.20.1 --root D:/mc      # 音效/语言/字体，621 MB
npx tsx src/cli/index.ts launch 1.20.1 --root D:/mc --instance rlcraft
```

`setup` 与 `assets` 分开：第一次装原版只下 80 MB 就能验证启动链路，621 MB 的音效可以晚点再补——没有 assets 也能进主界面，只是没声音。见 [ADR-0009](docs/adr/0009-assets-download.md)。

## 一条命令装整合包

```bash
npx tsx src/cli/index.ts deploy fixtures/real-pack.mrpack --root D:/mc --instance rlcraft
```

`.mrpack` 里已经写好了该用哪个 MC 版本、哪个 loader 版本。`deploy` 依次完成：原版文件 → 加载器 → 整合包模组 → overrides，最后直接给出启动命令。

```
BlockPilot Real Fixture
→ 原版文件（66 个，已存在则跳过）
→ 加载器（8 个库）
→ 整合包文件（sodium + fabric-api）
→ overrides（2 个文件）

装好了 1.20.1 + fabric 0.16.14
```

服务端专用的文件（`env.client: "unsupported"`）不会装到客户端。细节见 [ADR-0012](docs/adr/0012-deploy-orchestration.md)。

**装完会立刻自检**，而不是等启动时闪退：

```
部署后检查  BLOCKED
  ✗ DEPENDENCY_VERSION_MISMATCH  fabric-api 要求 fabricloader >=0.16.10，实际是 0.15.11
    → 加载器版本太低，换更高的 loader 版本重装

先别启动，上面这些会直接导致崩溃
```

检查读的是 jar 里的真实元数据，包括 `META-INF/jars/` 下的嵌套模组——Fabric API 的 57 个子模块都在那里。见 [ADR-0013](docs/adr/0013-post-deploy-check.md)。

## 加载器

Fabric、Forge、NeoForge 都支持，`deploy` 会按 `.mrpack` 里的 `dependencies` 自动选。

Forge 靠官方 installer 完成安装——它要给 client jar 打二进制补丁，自己复刻那套工具链没有意义。三个坑见 [ADR-0015](docs/adr/0015-forge-installer.md)：

- installer 要求 `launcher_profiles.json`（空壳即可）
- Forge 的版本目录只有 `.json`，patched client 在 `libraries` 里
- classpath 里**不能**有原版 jar，否则和 Forge 的 `minecraft` 模块冲突

NeoForge 与 Forge 共用 installer 流程，只是坐标不同（版本号不带 MC 前缀）。**但未实测**：`maven.neoforged.net` 在本机 DNS 可解析、TCP 连不上，且 BMCLAPI 没有镜像它。见 [ADR-0016](docs/adr/0016-neoforge.md)。

## Fabric 加载器

```bash
npx tsx src/cli/index.ts fabric 1.20.1 --root D:/mc              # 取最新 stable loader
npx tsx src/cli/index.ts fabric 1.20.1 --root D:/mc --loader 0.15.11
npx tsx src/cli/index.ts run fabric-loader-0.15.11-1.20.1 --root D:/mc
```

Fabric 的 profile 只有 8 个库和主类，其余全靠 `inheritsFrom` 合并父版本。三个坑见 [ADR-0011](docs/adr/0011-loader-version-merge.md)：

- `libraryKey` 必须含 classifier，否则 `org.lwjgl:lwjgl` 和它的 `natives-windows` 变体会互相覆盖
- natives 目录与 client jar 都要用 **rootId**，加载器版本没有自己的

**默认取最新 loader 不一定对**：0.20.1 跑 1.20.1 会崩在 `RenderSystem`，换同期 0.15.11 正常。`--loader` 是必要的逃生口。

## 真的启动

```bash
npx tsx src/cli/index.ts run 1.20.1 --root D:/mc --memory 2048
```

日志实时转成事件流（`--quiet` 只显示 ERROR），**同时落盘到 `<实例>/logs/`**。异常退出时打印日志路径和诊断入口：

```
  异常退出  code=1 · 12.3s · 428 行日志

  下一步
    blockpilot preflight "D:\mc\instances\default"
```

`launch` 崩溃后**不会自己调 preflight**——那是 CLI 的策略，不是 core 的能力。分层见 [ADR-0010](docs/adr/0010-launch-process.md)。

## 启动命令生成

```bash
npx tsx src/cli/index.ts launch 1.20.1 --root ./mc --memory 2048
```

输出完整命令行（`-cp` 折叠成 `<44 jars>`，`--raw` 看完整值）、Java 路径、主类，以及**缺失文件清单**。

这一步**只生成不启动**。理由见 [ADR-0007](docs/adr/0007-launch-command-first.md)：classpath 分隔符写错时，游戏会报「找不到主类」——错误信息指向完全无关的地方，一次错一次重启，排查成本极高。

已处理的坑：

- `rules` 语义是「最后一条匹配生效」，不是「任意 allow 放行」
- 模板替换后断言**没有 `${...}` 残留**（这条断言抓到了漏掉的 `${clientid}` / `${auth_xuid}`）
- 路径统一 resolve 成绝对路径，避免正反斜杠混用
- 缺失检查覆盖 client jar / libraries / assetIndex 三类

### 修复计划

报告里的 `plan` 是**可执行**的，不是建议：

```json
{
  "installs": [{
    "projectId": "AANobbMI",
    "versionId": "OihdIimA",
    "displayName": "Sodium 0.5.13 for Fabric",
    "fileName": "sodium-fabric-0.5.13+mc1.20.1.jar",
    "url": "https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/...",
    "size": 921600,
    "hashes": { "sha1": "...", "sha512": "..." },
    "requiredBy": ["YL57xq9U"]
  }],
  "manual": []
}
```

字段与下载器需要的完全对齐——这是「检查 → 一键修 → 再检查」闭环的接口。

### 下载

`install` 会把 `plan.installs` 真正落地：

```bash
npx tsx src/cli/index.ts install fixtures/closure.mrpack --mods-dir /tmp/mods
```

规则（[ADR-0005](docs/adr/0005-download-and-mirrors.md)）：

- **源是候选列表，不是唯一地址。** 逐个尝试，直到成功。
- **每个源下载后都要校验哈希，校验失败等同于下载失败。** 镜像活着、HTTP 200、大小对得上，都不能说明内容正确。
- **没有哈希的任务拒绝下载。** 宁可不下，不可下错。
- `.part` + rename 保证原子性，中途崩溃不会留下半个 jar。
- 已存在且哈希匹配直接跳过。

内置三个源，各有边界：

| 源 | 覆盖 | 实测（2026-10-25） |
|---|---|---|
| `bmclapi` | Mojang 版本/资源/库、Forge/NeoForge/Fabric maven | 可用 |
| `direct` | 全部 | — |
| `mcim` | Modrinth / CurseForge 文件 | API `200`；文件可能 302 跳回官方（未缓存） |

默认顺序 `[bmclapi, direct, mcim]`：MCIM 官方自己建议「下载失败后再用镜像」，所以放在直连之后。要国内优先用 `chinaFirstSources()`，CLI 里加 `--china`。

**BMCLAPI 不覆盖 Modrinth CDN**，对模组文件没意义；它加速的是启动原版游戏要用的那些资源。反过来，MCIM 真正的价值在 API 加速——`ModrinthSource` 支持传 `apiBase: MODRINTH_API_MCIM`。

加别的镜像用 `createMirrorSource({ name, from, to, credit })`，地址写在配置里而不是源码里——镜像站的域名寿命通常比代码短。

依赖闭包是递归的：实例里只装了 Iris，它会顺着 Iris 的 required 依赖反查到 Sodium，并告诉你该装哪个版本。它**不做版本范围求解**——Modrinth 的元数据里根本没有版本范围，硬做等于用假精度骗自己。理由见 [ADR-0003](docs/adr/0003-dependency-closure.md)。

设计细节见 [ADR-0002](docs/adr/0002-preflight-first.md)。

## 两条不能破的规矩

1. **core 里没有 `console.log`。** 所有状态变化先成为 `OpEvent`，由消费者决定怎么显示。
2. **AI 不能启动游戏，也不能碰登录凭证。** 这两件事不可回滚，必须由人亲手触发。装错模组能删，用你的账号启动一次游戏撤不回来。

见 [ADR-0001](docs/adr/0001-operation-event-stream.md)。

## 术语

见 [GLOSSARY.md](GLOSSARY.md)。写 issue 和测试名时用那里的词。

## 合规

这个项目调用的是第三方**公益**服务，它们的协议是硬约束，不是建议：

| 服务 | 要求 | 本项目的做法 |
|---|---|---|
| BMCLAPI | UA 以 `${NAME}/${VERSION}` 开头；**下载界面或其他可视部分必须标明来源**；禁止在其上二次封装其他协议 | `USER_AGENT = 'BlockPilot/0.0.1'`（[MCLF-CN/docs#2](https://github.com/MCLF-CN/docs/issues/2)）；下载完成打印「资源来源」；只做下载加速，不代其对外提供 API |
| MCIM | 使用前**登记启动器 UA**；禁止二次封装接口 | UA 集中在 `src/core/user-agent.ts`；登记见 [mcim-rust-api#12](https://github.com/mcmod-info-mirror/mcim-rust-api/issues/12) |
| Modrinth | 必须带可识别 UA；300 req/min | 统一 UA，元数据 100 个一批 |

`DownloadSource.credit` 不是装饰字段——BMCLAPI 要求的「标明来源」必须能被渲染出来，所以它进了类型定义、透传到 `DownloadOutcome`、并由 CLI 打印。

## 状态

早期，但核心链路已经通了。

**已完成**：`.mrpack` 与实例目录解析、jar 元数据读取（fabric/forge/neoforge/quilt，含 `provides` 子模块）、约束检查、递归依赖闭包、可执行修复计划、并发下载（哈希校验 / 多源降级 / 缓存命中）、Java 检测与版本判定、原版安装（client jar + libraries + assetIndex + natives 解压 + assets 对象）、启动命令生成（rules / classpath / 参数模板）、进程启动与日志事件化、Modrinth 元数据源、CLI 与 MCP 两个消费者。

**全链路已跑通**：`.mrpack` → 部署 → 启动 → 59 个 mod 加载成功。原版、Fabric 两条路都实测到主菜单。

**未开始**：Linux/macOS 的 Java 安装（tar.gz）、NeoForge 实测、CurseForge 支持、版本求解、堆栈解析、GUI。

## 许可

MIT
