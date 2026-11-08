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

## 检查与测试

| 命令 | 覆盖 |
|---|---|
| `npm run typecheck` | `src/**` + `scripts/**`（两个 tsconfig） |
| `npm test` | `src/**/*.test.ts` + `scripts/**/*.test.ts`，全离线 |
| `npm run e2e` | T0 + T1（约 30 s） |
| `npm run e2e -- --tier 3 --only E2E-301` | 真启动，会开游戏窗口 |
| `npm run smoke` | MCP 工具清单 + diag 结构化输出 |

迭代时只跑改到的文件（`npx tsx --test src/core/xxx.test.ts`），提交前跑全量。
