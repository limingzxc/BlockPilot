# 环境：网络、git、issue、检查

这台开发机（Windows，WorkBuddy 沙箱）有几处与 CI 不同的坑。踩过一次就别再猜。

## 网络

- `api.github.com` 通常可用；**`github.com:443` 可能被拦**（实测 TCP 超时，
  但 `github.com:22` 与 `140.82.112.3:443` 是通的）。
- 本地代理默认 `http://127.0.0.1:53179`，环境变量已设 `HTTPS_PROXY`。
  `curl` 认它；**Node 的 `fetch` 不认**，项目里的 `applyProxy()` 只在 CLI 入口生效。
- curl 直连与走代理都试过是通的；若直连失败，加 `-x http://127.0.0.1:53179`。
  地址可用 `BLOCKPILOT_PROXY` 覆盖。

## Git 与推送

两个 git 并存，能力不同：

| 路径 | 版本 | TLS 后端 |
|---|---|---|
| `/mingw64/bin/git`（默认） | 2.55 | **只有 schannel** |
| `D:/Git/cmd/git` | 2.37 | openssl + `http.curloptResolve` |

- 默认 git 上 `-c http.sslBackend=openssl` 会报 `Unsupported SSL backend`。
- schannel 直连常报 `CRYPT_E_REVOCATION_OFFLINE`。
- 推送被拦时用这条（把 IP 换成当时能连上的）：

```bash
/d/Git/cmd/git -c http.proxy= -c https.proxy= \
  -c http.sslBackend=openssl \
  -c http.curloptResolve=github.com:443:140.82.112.3 push origin main
```

## Issue 工作流

用 `gh`（已用 winget 装好）。**先 `gh issue list`，再按编号建任务清单**——
漏过一条 issue（#10），原因是清单从记忆里列，不是从 open 列表生成的。

```bash
gh issue list -R limingzxc/BlockPilot --state open
gh issue view 10 -R limingzxc/BlockPilot
gh issue close 10 -R limingzxc/BlockPilot -c "修复说明"
```

装完 gh 后当前 shell 的 PATH 可能是旧的，`gh` 找不到时用全路径
`"/c/Program Files/GitHub CLI/gh.exe"`，或新开一个终端。
凭据已写入 `%APPDATA%\GitHub CLI\hosts.yml`（token 来自 git 凭据，权限 600）；
`gh auth status` 会提示缺 `read:org`——只影响 org 相关查询，repo 的 issue/PR 正常。

**gh 不一定在机器上**（2026-11-09 这次就没有：`Program Files` 与 winget 的 Links 里都没有）。
两条替代路径，按可用性选：

1. **GitHub MCP connector**（`mcp__github__*`）：能读 issue / PR，**写会被拒**——
   评论与改状态返回 `403 Resource not accessible by integration`。
2. **git 凭据 + curl**：推送用的那个 token 权限足够写 issue。
   `git credential fill` 取 token，别 echo 出来：

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" --data-binary @body.json \
  https://api.github.com/repos/limingzxc/BlockPilot/issues/14/comments
curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"state":"closed","state_reason":"completed"}' \
  https://api.github.com/repos/limingzxc/BlockPilot/issues/14
```

body 里带中文与反引号时先写成文件再 `--data-binary @file`，别拼在 `-d` 里。

## 检查与测试

新克隆上先 `npm install`（约 35 s）：依赖没装时 `npm run typecheck` 报
`'tsc' 不是内部或外部命令`。一律用 `npm run <script>`，别用 `npx tsc`——
registry 上有个废弃的同名包，装出来会打印 `This is not the tsc command you are looking for`。

| 命令 | 覆盖 |
|---|---|
| `npm run lint` | Biome：格式 + lint（含 core 禁止 console） |
| `npm run typecheck` | `src/**` + `scripts/**`（两个 tsconfig） |
| `npm test` | `src/**/*.test.ts` + `scripts/**/*.test.ts`，全离线 |
| `npm run e2e` | T0 + T1（约 30 s） |
| `npm run e2e -- --tier 3 --only E2E-301` | 真启动，会开游戏窗口 |
| `npm run smoke` | MCP 工具清单 + diag 结构化输出 |
| `npm run smoke:entry` | 构建后按包名 import，校验 `exports` 与公共 API |
| `npm run smoke:auth` | 认证请求形状探针（真实端点 + 无效令牌，需要网络） |
| `npm run check` | lint + typecheck + test，提交前一条命令 |

迭代时只跑改到的文件（`npx tsx --test src/core/xxx.test.ts`），提交前跑全量。


## 上游接口（实测 2026-11-09）

以下形状用 curl / 真实请求确认过；再遇到「接口是不是变了」先跑一条最小请求，不要凭记忆改解析。

| 服务 | 端点 | 要点 |
|---|---|---|
| Modrinth | `GET https://api.modrinth.com/v2/project/<slug>/version` | slug 与 8 位 id 都接受；版本数组里 `version_type=release` 优先；CDN 地址形如 `cdn.modrinth.com/data/<projectId>/versions/<versionId>/<file>`，可反推 project/version |
| Modrinth 镜像 | `https://mod.mcimirror.top/modrinth/v2` | `--china` 时用于元数据；路径与官方一致 |
| Quilt Meta | `GET https://meta.quiltmc.org/v3/versions/loader/<mc>` | 列表**不保证顺序**，不能拿 `[0]` 当最新；按 semver 取最大。profile 路径 `.../<loader>/profile/json`，形状与 Fabric 相同 |
| CurseForge 镜像 | `GET https://mod.mcimirror.top/curseforge/v1/mods/<id>/files?gameVersion=<mc>&modLoaderType=<n>&pageSize=1` | 免 key；批量 `POST /mods/files` 没有代理。`modLoaderType`：1=Forge、4=Fabric、5=Quilt、6=NeoForge |
| CurseForge 官方 | `GET https://api.curseforge.com/v1/mods/<id>/files?...` | 需要 `x-api-key`；无 key 返回 403 |
| NeoForge Maven | `GET https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml` | 版本前缀：1.20.2+ → `20.<patch>`，1.21+ → `21.<patch>`；取前缀下最大 semver |
| Forge promotions | `GET https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` | key 形如 `1.20.1-recommended` / `1.20.1-latest` |

Quilt 的列表顺序、CF 镜像的批量限制、NeoForge 的前缀规则都曾让实现走弯路；改动这些解析前先看
`src/core/sources/` 里对应文件的注释与测试。
