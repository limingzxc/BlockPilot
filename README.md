# BlockPilot

命令行的 Minecraft 启动器内核：**装整合包、查兼容性、启动游戏、崩了告诉你是哪个模组**。

没有图形界面，所有操作都是一条命令。适合不想点鼠标的玩家、整合包作者，以及想把「装游戏」
交给脚本或 AI 的人。

## 装上

需要 Node 20+（开发用 22）。还没有发布到 npm，先从仓库装：

```bash
git clone https://github.com/limingzxc/BlockPilot.git && cd BlockPilot
npm install && npm run build && npm link
```

之后就能直接敲 `blockpilot` 了。不想动全局命令，用 `node dist/cli/index.js <命令>` 效果一样。

数据默认放在 `%APPDATA%\BlockPilot`（macOS 是 `~/Library/Application Support/BlockPilot`，
Linux 是 `~/.local/share/blockpilot`）。想放别的盘加 `--root`，**只需要选这一次**，实例目录
会自动派生。

## 装一个整合包，然后玩

```bash
blockpilot deploy ~/Downloads/Fabulously.Optimized.mrpack --root D:/mc --instance fo
```

包里已经写好了要哪个 MC 版本、哪个加载器，不用你选：

```
→ 原版文件
→ 加载器
→ 整合包文件
→ overrides

  装好了  1.21.1 + fabric 0.19.3
  模组 50 个（下载 50 / 跳过 0 失败 0）· overrides 63 个文件

  部署后检查  OK

  启动
    blockpilot run fabric-loader-0.19.3-1.21.1 --root D:/mc --instance fo
```

照最后一行敲就进游戏。首次约 150 MB（原版 + 库 + 模组）。

想要声音和字体再补一次（可后补，不装也能进游戏）：

```bash
blockpilot assets 1.21.1 --root D:/mc     # 约 790 MB
```

Fabric、Forge、NeoForge 都支持，按包里的声明自动选。Forge 类要跑官方 installer，
会多花 1–3 分钟。

**同一个实例可以反复 deploy**：已经下过的文件会跳过，不会重装一遍。

## 装之前，先看它能不能跑

```bash
blockpilot preflight ~/Downloads/MyPack.mrpack
```

```
  verdict   WARN
  mods      48  (resolved 47, unresolved 1)

  ! UNVERIFIED_DEPENDENCY  3IuO68q1 需要前置模组 codAaoxh，整合包里没有它（可能已内置在某个模组里）
    → 整合包常把依赖打在 jar-in-jar 里；装完跑一次 preflight <实例目录> 确认，确有缺失再补装
```

整合包会把依赖直接打进模组 jar 里（jar-in-jar），装之前看不到这一层，所以这类问题只报
WARN、不判 BLOCKED——**预检只说有证据的话**。

装好的实例查得更准，而且完全离线、不发任何请求：

```bash
blockpilot preflight D:/mc/instances/fo
```

确实缺依赖时，`install` 给出带文件名、下载地址、sha1 的计划：

```bash
blockpilot install ~/Downloads/MyPack.mrpack --mods-dir D:/mc/instances/fo/mods
```

计划里每一项都带 `confidence`：`unverified` 表示「包里没看到，但可能被内置」，默认不装——
装一个重复的模组只会改掉整合包作者选定的版本。确认缺了再加 `--include-unverified`。

加 `--json` 输出结构化报告，方便脚本处理。

## 崩了

```bash
blockpilot logs --root D:/mc    # 有哪些会话日志
blockpilot diag --root D:/mc    # 分析最近一次
```

```
最可能的根因

  ✗ mod-crash  第 9 行
    java.lang.RuntimeException: Ticking screen
    → 异常来自 Just Enough Items（jei），文件 jei.jar。先禁用或更新它，看崩溃是否消失

指向的模组（按证据强度排序，越靠前越可能是它）

  ✗ jei · Just Enough Items 15.74.0.229
    jei.jar · 2 个栈帧
    · 根因区段最上面的一帧
    · 包名属于它：mezz.jei.common、mezz.jei.gui
```

**定位不到时会直说**，不会猜一个名字给你——照着删错模组，问题还在，还多一个。

日志里没有致命异常、只是某条非致命告警时，它也会明说这一点，不会把「可疑」讲成「崩在谁」。

## 常用命令

| 我想…… | 命令 |
|---|---|
| 装整合包 | `blockpilot deploy <pack.mrpack> --root <dir>` |
| 装完启动 | `blockpilot run <版本 id> --root <dir> --instance <name>` |
| 查包或查实例能不能跑 | `blockpilot preflight <包或实例目录>` |
| 缺依赖，看是否能确认 | `blockpilot install <包> --mods-dir <实例>/mods` |
| 只看启动命令，不启动 | `blockpilot launch <版本 id> --root <dir>` |
| 崩了查原因 | `blockpilot diag --root <dir>` |
| 装原版 / 补音效 | `blockpilot setup <mc>` / `blockpilot assets <mc>` |
| 看 Java / 装 Java | `blockpilot java` / `blockpilot java install 21` |
| 正版服务器 | `blockpilot login` / `blockpilot accounts` |

版本 id 就是 `deploy` 打印出来的那个，例如 `fabric-loader-0.19.3-1.21.1`。

## 常见问题

**提示找不到 Java / `JAVA_MISSING`**
`blockpilot java` 看本机有什么，没有就 `blockpilot java install 21`。装好的会被优先使用，
不会去抢系统里那个。需要更高版本的游戏（比如 MC 26.2 要 Java 25），读的是版本 JSON 里写的
要求，不是按版本号猜。

**`--memory` 填错**
只接受整数 MB，范围 512–65536。填 `abc`、`-1`、`0` 会在启动前直接报 `BAD_MEMORY`，不会让
JVM 去报一句看不懂的 `Unrecognized option`。一般整合包 4096 起，大型包 8192。

**进游戏没声音、字体是方框**
`blockpilot assets <mc> --root <dir>`。这一步是几千个小文件，慢是正常的。

**下载慢或者连不上**
加 `--china` 走国内镜像，**镜像失败会自动退回官方源**，不会卡死在镜像上。有代理时
`--proxy http://127.0.0.1:1081` 质量更好，也读 `HTTPS_PROXY` 环境变量。

**进不了正版服务器**
需要登录，见下一节。离线模式只能玩单人。离线用户名只能用字母、数字、下划线（1–16 位），
中文名能进单人，联机会被拒——填了不合规的名字，程序会提醒你。

**装了整合包，但游戏里一个模组都没有**
多半是打包时多套了一层目录（`MyPack/mods/x.jar`）。`preflight` 会提示「没有可检查的模组」，
而不是假装检查通过。

**装的东西占多少空间**
库和音效是**所有实例共享**的，只有实例目录各自独立，所以多开几个整合包不会成倍增长。
想整体搬走，把 `--root` 指的目录拷走就行。

**日志在哪**
`<root>/instances/<实例>/logs/`，每次启动写新文件，保留最近 10 份，不会覆盖游戏自己写的
`latest.log`。

## 正版登录

不登录也能玩单人和离线整合包。要进正版服务器才需要这一步，**且需要你自己注册一个 Azure
应用**（免费，一次就够）：

1. 打开 [portal.azure.com](https://portal.azure.com) → 应用注册 → 账户类型选「仅个人 Microsoft 账户」
2. 身份验证 → 开启「允许公共客户端流」
3. API 权限 → 添加委托权限 `XboxLive.signin`
4. 复制「应用程序(客户端) ID」

```bash
export BLOCKPILOT_CLIENT_ID=<上一步的 id>
blockpilot login --root D:/mc
```

```
  1. 打开  https://microsoft.com/link
  2. 输入  AB12-CD34
```

在浏览器里输完码，回来就登好了。之后 `run` 默认用这个账号，令牌过期会自动续。

```bash
blockpilot accounts                   # 看有哪些账号
blockpilot run ... --account Notch    # 指定账号
blockpilot run ... --offline          # 强制离线
```

为什么必须自己注册：第三方启动器不能复用官方启动器的应用 id，那是冒充。密码只输在微软
页面上，本项目不碰。

> 这条路代码与测试齐全，但**还没有一次真实登录的实测记录**（缺 Azure 应用 id 与正版账号）。
> 第一次用如果有问题，带上错误码反馈。

## 现在还不能做的

- **没有图形界面**，也不打算做——这是内核，界面交给上层
- **CurseForge 整合包只能检查不能装**：清单里没有下载地址，装要 CurseForge 的 API key
- **Linux / macOS 没跑过端到端**：CI 两个平台都跑测试，但没在目标平台真启动过游戏
- 不自动挑「最合适的模组版本」——元数据里没有版本范围，猜一个不如不猜

## 给写脚本 / 接 AI 的人

`preflight --json` 输出结构化报告，`diag --json` 输出结构化诊断（`verdict` / `primary` /
`culprits`）。退出码：`0` 通过（包括「没验成」）、`1` 参数或环境错误、`2` 判定为有问题
（预检 BLOCKED，或诊断出崩溃）。

MCP 客户端可以挂两个只读工具：

```json
{
  "mcpServers": {
    "blockpilot": {
      "command": "node",
      "args": ["D:/BlockPilot/dist/mcp/server.js"]
    }
  }
}
```

`args` 里的路径按你本机的实际位置改。

`preflight_modpack` 查包能不能跑，`diagnose_crash` 把崩溃归因到模组。**下载和启动刻意
没有暴露**——写盘和用你的账号启动都不可回滚，交给人在看到结论后自己决定。

## 参与开发

改代码、跑测试、提交规范与设计决策见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT（见 [LICENSE](LICENSE)）。内置的 BMCLAPI、MCIM 镜像有各自的协议要求，已按对方要求
落实，下载结束后会打印资源来源。
