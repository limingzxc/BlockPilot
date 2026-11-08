<div align="center">

# BlockPilot

命令行的 Minecraft 启动器内核：安装整合包、检查兼容性、启动游戏、把崩溃归因到模组。

[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
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

需要 Node 20+，尚未发布到 npm。

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
| `deploy <包>` | 安装整合包：原版、加载器、模组、overrides |
| `run <版本 id>` | 启动游戏 |
| `launch <版本 id>` | 只打印启动命令 |
| `preflight <包或目录>` | 检查能否运行 |
| `install <包>` | 生成并执行补装计划 |
| `setup <mc>` | 安装原版 |
| `assets <mc>` | 安装资源 |
| `java` · `java install <主版本>` | 查看 · 安装 Java |
| `diag` · `logs` | 崩溃归因 · 会话日志 |
| `login` · `accounts` | Microsoft 账号 |

完整参数与默认值：`blockpilot --help`。常用开关：`--root`、`--china`（镜像优先，失败回退官方源）、`--proxy`、`--memory`（512–65536）。

## 正版登录

单人与离线整合包无需登录。进入正版服务器需要 Microsoft 账号，并要求自建 Azure 应用（免费，一次即可）：

1. [portal.azure.com](https://portal.azure.com) → 应用注册 → 账户类型「仅个人 Microsoft 账户」
2. 身份验证 → 允许公共客户端流
3. API 权限 → 委托权限 `XboxLive.signin`
4. 记录应用程序(客户端) ID

```bash
export BLOCKPILOT_CLIENT_ID=<客户端 ID>
blockpilot login --root D:/mc
```

浏览器输入设备码完成登录，之后 `run` 默认使用该账号，令牌过期自动续。第三方启动器不能复用官方应用 ID；密码只提交给微软。

> 尚无真实登录的实测记录。

## 程序接口

`preflight --json` 与 `diag --json` 输出结构化结果。

退出码：`0` 通过（含未验证）、`1` 参数或环境错误、`2` 判定有问题。

`install` 只对安装负责：`0` 无需补装或全部成功，`2` 有文件失败，预检结论不进入退出码。

MCP 提供两个只读工具 `preflight_modpack`、`diagnose_crash`。下载与启动不暴露，因为写盘和账号启动不可回滚。

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
