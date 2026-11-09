<div align="center">

# BlockPilot

命令行的 Minecraft 启动器内核：安装整合包、检查兼容性、启动游戏、把崩溃归因到模组。

[![Node](https://img.shields.io/badge/Node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#状态)

[安装](#安装) · [用法](#用法) · [命令](#命令) · [开发](#开发)

</div>

没有图形界面，所有操作是一条命令。

参考实现：定义「装、查、跑、诊」的接口与分层，不追求功能数量。

- **安装**：`.mrpack` 与 CurseForge `.zip`，版本与加载器取自包内声明
- **预检**：检查依赖、Java、assets、版本兼容，只说有证据的结论
- **诊断**：把崩溃栈归因到具体模组，附证据来源
- **集成**：`--json` 结构化输出，MCP 暴露两个只读工具

## 安装

需要 Node 22.19+（`undici` 8 的 engines 要求），尚未发布到 npm。

```bash
git clone https://github.com/limingzxc/BlockPilot.git && cd BlockPilot
npm install && npm run build && npm link
```

数据目录默认 `%APPDATA%\BlockPilot`，macOS 为 `~/Library/Application Support/BlockPilot`，Linux 为 `~/.local/share/blockpilot`。

`--root` 只需指定一次，实例目录自动派生。

## 用法

安装并启动一个整合包，版本 id 取自 `deploy` 输出：

```bash
blockpilot deploy ~/Downloads/Fabulously.Optimized.mrpack --root D:/mc --instance fo
blockpilot run fabric-loader-0.19.3-1.21.1 --root D:/mc --instance fo
```

加载器按包内声明选择；1.6.4 / 1.7.10 / 1.12.2 使用 Legacy Fabric。首次约 150 MB，重复执行跳过已下载文件。

CurseForge 的 `.zip` 同样支持，不需要 API key，清单经 MCIM 镜像解析。

1.19 及以后必须安装 assets。缺失时崩溃在标题画面，而非无声音：

```bash
blockpilot assets 1.21.1 --root D:/mc
```

检查兼容性：

```bash
blockpilot preflight ~/Downloads/MyPack.mrpack   # 查包
blockpilot preflight D:/mc/instances/fo          # 查已安装实例，离线
```

依赖可能已打包进模组 jar（jar-in-jar）时只报 WARN，不判 BLOCKED。确认缺失后生成补装计划：

```bash
blockpilot install ~/Downloads/MyPack.mrpack --mods-dir D:/mc/instances/fo/mods
```

每项带 `confidence`。`unverified` 表示包内未见但可能内置，默认不安装，`--include-unverified` 覆盖。

崩溃诊断：

```bash
blockpilot diag --root D:/mc
```

输出根因、异常位置与候选模组，按证据强度排序。无法归因时明确说明，不猜测模组名。历史日志用 `blockpilot logs`。

## 命令

| 命令 | 用途 |
|---|---|
| `deploy <包\|slug>` | 安装整合包：本地 `.mrpack` / CF zip，或 Modrinth project slug |
| `verify` | 按 `.blockpilot/lock.json` 核对已装文件：缺失与哈希不符 |
| `update` | 按 lock 检查/应用模组更新；`--loader` 升级加载器 |
| `config` | 查看/修改实例默认内存、Java、JVM 参数 |
| `run <版本 id>` | 启动游戏 |
| `launch <版本 id>` | 只打印启动命令 |
| `preflight <包或目录>` | 检查能否运行 |
| `install <包>` | 生成并执行补装计划 |
| `setup <mc>` | 安装原版 |
| `assets <mc>` | 安装资源 |
| `java [install <主版本>]` | 查看 · 安装 Java |
| `fabric <mc>` | 安装 Fabric / Legacy Fabric |
| `quilt <mc>` | 安装 Quilt |
| `forge <mc>` | 安装 Forge |
| `neoforge <mc>` | 安装 NeoForge |
| `login` | Microsoft 账号登录 |
| `accounts` | 列出已保存的账号 |
| `logs` | 列出会话日志 |
| `diag` | 崩溃归因 |

完整参数与默认值：`blockpilot --help`。常用开关：`--root`、`--china`（镜像优先，失败回退官方源）、`--proxy`、`--memory`（512–65536）。
`deploy` 另有 `--allow-host`（放行 mrpack 清单里的额外下载域名）与 `--overwrite-overrides`（重跑时覆盖你改过的配置；默认跳过）。

## 正版登录

单人与离线整合包无需登录。进入正版服务器需要 Microsoft 账号：

```bash
blockpilot login --root D:/mc
```

终端给一个网址和一个短码，在浏览器里输入即可。密码只提交给微软的页面，不经过启动器。之后 `run` 默认使用该账号，令牌过期自动续；只有 refresh_token 失效（改密码、被撤销、90 天未用）才需要重登。

内置 BlockPilot 自己的 Azure 应用 id（公共客户端，无密钥），不需要自己注册应用。

第三方应用访问 Java 版游戏服务 API 需要 Mojang 人工审核并加入白名单。本应用**审核通过前**，`login` 会停在最后一跳，报 `MC_APP_NOT_ALLOWLISTED` 并给出申请入口——那不是账号问题，重试无用。想用自己的应用：

1. [portal.azure.com](https://portal.azure.com) → 应用注册 → 账户类型「所有 Microsoft 账户」
2. 身份验证 → 允许公共客户端流
3. API 权限 → 委托权限 `XboxLive.signin`
4. `blockpilot login --client-id <id>`，或 `export BLOCKPILOT_CLIENT_ID=<id>`

不要复用官方启动器或其他启动器的应用 id——那是冒充。见 ADR-0039。

## 程序接口

`preflight --json` 与 `diag --json` 输出结构化结果。

退出码：`0` 通过（含未验证）、`1` 参数或环境错误、`2` 判定有问题。

`install` 只对安装负责：`0` 无需补装或全部成功，`2` 有文件失败，预检结论不进入退出码。

MCP 提供两个只读工具 `preflight_modpack`、`diagnose_crash`。下载与启动不暴露，因为写盘和账号启动不可回滚。

也可以作为库使用（`package.json` 的 `exports` 指向 `dist/index.js`）：

```ts
import { createPreflight, Op, resolveLayout } from 'blockpilot'
```

仍不承诺 npm 发布；公共面只覆盖 Operation、事件、布局、错误与内容源契约。

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

## 状态

- 无 GUI，也不计划提供
- Linux / macOS 未做端到端验证：CI 运行测试，未在目标平台实际启动游戏
- 不自动选择「最合适的模组版本」：元数据无版本范围，不猜测

## 开发

`npm test`、`npm run e2e`。规范与设计决策见 [CONTRIBUTING.md](CONTRIBUTING.md)，架构记录见 [docs/adr/](docs/adr/)。

MIT（见 [LICENSE](LICENSE)）。内置的 BMCLAPI、MCIM 镜像按其协议要求使用，下载结束后打印资源来源。
