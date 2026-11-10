# 实测（E2E）方案

> 状态：v1 · 2026-10-28 · 执行器 `scripts/e2e.ts` · 结果见 `docs/testing/2026-10-28-run.md`

单元测试证明「函数按我理解工作」，实测证明「用户按 README 敲下去能用」。这两件事在
这个项目里已经分叉过一次：ADR-0014 压真实整合包，一口气压出三个 bug（`~1.21` 写法、
unknown 当违规、`/[xX*]/` 吃单词），自造 fixture 一个都测不出来。

2026-10-25 之后 core 又做了 5 次重构（delegate 转发、下载批、ModIndex 生命周期、
Java 选择用例、CLI 消费循环）并新增了 auth。242 个单测全绿，但「装完能启动」这条链
没有回归网。这套实测补的就是它。

## 1. 判定原则

1. **黑盒**：只通过 `dist/cli/index.js` 与 MCP stdio 调用，不 import 内部模块。
   用户拿到的是 `bin` 指向的那个文件，测它才有意义。
2. **机器可判**：退出码 + 剥掉 ANSI 的文本 + JSON 字段 + 文件系统事实（存在、大小、
   sha1、计数）。不用人眼看「输出挺正常」。
3. **证据留档**：每条用例的每次命令都写进 `.tmp-e2e/<时间>/<用例>/`（args、退出码、
   stdout、stderr、耗时），失败时直接指到文件。
4. **离线可证**：T0 把 `HTTPS_PROXY` 指向死端口（`127.0.0.1:9`）再跑。任何偷偷发请求
   的实现都会立刻暴露，而不是靠「我读代码觉得它没联网」。
5. **已知缺陷不阻塞**：用例可以标 `knownIssue`。失败记 `KNOWN`（不算红），修好后变
   `XPASS` 提醒删标记。测试套件不能因为已知 bug 长期红着，红了就没人看。
6. **不碰用户数据**：所有写入落在 `.tmp-e2e/`；`fixtures/mcroot` 只读。

## 2. 环境事实（2026-10-28 实测，不是假设）

| 项 | 值 |
|---|---|
| 系统 | Windows 11，D: 剩 40 GB |
| Node / npm | 22.22.2 / 10.9.7 |
| Java | 系统 GraalVM CE 21.0.4；`fixtures/mcroot/java/jdk-21.0.12.1+1-jre` |
| 单测基线 | 242 / 242，5.4 s（全离线） |
| 真实资产 | `fixtures/mcroot` 1.7 GB：8 个实例、11 个版本、FO 6.5.0 全量 48 mod |
| 真崩溃样本 | `testdata/instances/crash/`（controlify mixin 注入失败，含极小 mods/ 供归因） |
| 真登录失败样本 | `testdata/instances/auth/logs/auth-failed.log`（authlib 401） |

网络（同一台机器，逐条 curl 实测）：

| 端点 | 结果 |
|---|---|
| `piston-meta.mojang.com` | 200 / 1.4 s |
| `api.modrinth.com` | 200 / 1.8 s |
| `api.adoptium.net` | 200 / 1.0 s |
| `bmclapi2.bangbang93.com` | 302 → USTC 镜像；fabric-loader 2.0 MB / 7.7 s |
| `maven.fabricmc.net` | 直连约 10 s（慢但不挂）；经代理 12 s 超时 |
| `maven.neoforged.net` | 12 s 超时（只能靠 `neoforged.forgecdn.net`） |

最后两行是环境事实，不是产品缺陷——但它决定了 T2 里 Fabric 加载器安装的耗时预期，
以及为什么 `--china` 必须单独测。

### 重建真实夹具

`fixtures/` 被 gitignore，换机器或清缓存后要按下面顺序重建。小件可以自动拉：

```bash
npm run fixtures
```

它只下载 FO 6.5.0 `.mrpack` 和 E2E-303 用的 sodium 1.20.1 jar，并校验 sha1。
`fixtures/mcroot` 的其余内容是真实下载，必须手动执行：

```bash
npm run build
node dist/cli/index.js deploy fixtures/fo-6.5.0.mrpack --root fixtures/mcroot --instance fo
node dist/cli/index.js assets 1.21.1 --root fixtures/mcroot
node dist/cli/index.js java install 21 --root fixtures/mcroot
```

注意：

- `assets` 约 788 MB，脚本刻意不默认拉；
- `deploy` 后如果自检报 `ASSETS_MISSING`，先跑 `assets` 再 `run`；
- T2+ 会写盘、联网，E2E-301 会打开游戏窗口；CI 环境会拒绝执行。

## 3. 用例表

### T0 离线（约 40 s，零网络）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-001 | 入口契约 | `--help`→0 且列出 12 个子命令；未知命令→1；无参→0 |
| E2E-002 | 构建产物 | `npm run build`→0；`node dist/cli/index.js --help`→0 |
| E2E-003 | 离线预检·缺依赖 | `instance-miss`→2；BLOCKED；`MISSING_DEPENDENCY`；subject=`sodium` |
| E2E-004 | unknown 不是违规 | `instance-ok`→0；UNKNOWN；无 blocker（ADR-0013 的承诺） |
| E2E-005 | JSON 契约 | 四字段齐全、类型正确、`generatedAt` 可解析 |
| E2E-006 | 真实崩溃归因 | FO mixin 日志→2；`primary.kind=mixin`；第一名 `controlify` |
| E2E-007 | 真实登录失败归因 | authlib 401 日志→0；`auth-failed`；hint 指向 `login` |
| E2E-008 | 干净日志不误报 | forge-test 成功日志→0；「没有在日志里找到异常」 |
| E2E-009 | 日志清单 | 含 `latest.log` 且标 `[游戏原生]`，条目 ≥ 2 |
| E2E-010 | 只出命令不启动 | `launch --raw`→0；含 `KnotClient`、`-cp`、`所有依赖文件都在位` |
| E2E-010B | 断网也能出命令 | 文件齐全时死代理下 `launch --raw`→0（不许联网） |
| E2E-011 | 真实 jar 全部可读 | FO 48 个 jar，`UNREADABLE_JAR` 必须为 0 |
| E2E-012 | 自建实例版本可识别 | `preflight instances/fo` 不出现 `UNKNOWN_GAME_VERSION` |
| E2E-013 | MCP stdio | 2 个工具；`diagnose_crash` 对真实日志返回 `verdict=crash` |
| E2E-014 | `--memory` 校验 | 非法值→1；`BAD_MEMORY`；合法值→0 且含 `-Xmx4096M` |
| E2E-015 | `verify` | 正常→0「全部文件与清单一致」；篡改后→2 且 `reason=mismatch` |
| E2E-016 | hs_err | 只有 `hs_err_pid*.log` 时→2；`format=hs-err`；`primary.kind=graphics` |
| E2E-017 | 实例配置 | `config` 写入→读取一致；`--unset memory` 只删内存；非法值→1 `BAD_MEMORY` |
| E2E-019 | `--events` | stdout 全是 JSON 行；含 `schemaVersion=1`；最后 `type=exit, code=2`；无 ANSI |
| E2E-020 | `config --jvm-args` 进启动命令 | 写入后 `launch` 输出含 `--add-opens` 与完整值，同时保留 `-Xmx2048M` |
| E2E-021 | `install --events` | stdout 全是 JSON；只有一个 `exit` 且在最后；无 ANSI |
| E2E-022 | `--stop` 非法值 | 退出码 1；稳定码 `BAD_STOP`，不把 NaN 交给 `setTimeout` |
| E2E-023 | `--events` 令牌 | 在线账号启动时 stdout 不含真实 token；`result.value.args` 里 `--accessToken` 为 `***` |

E2E-011 / 012 是本轮新发现，先按 knownIssue 记录（见 §5）。

### T1 只读网络（约 40 s，< 1 MB）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-101 | 真实 FO 包必须能跑 | verdict `ok/warn`；`MISSING_DEPENDENCY` 为 0；unresolved ≤ 1 |
| E2E-102 | 修复计划不能推荐重复 mod | FO 的 `plan.installs` 为空（依赖已在 JiJ 里） |
| E2E-103 | 真实小包 | `real-pack.mrpack` 无 blocker；resolved ≥ 2 |
| E2E-104 | CF 边界 | `cf-pack.zip --no-cf-mirror`→0；WARN；`CF_NO_MOD_CHECK`，不硬判 blocked |
| E2E-105 | setup 只算不装 | `setup 1.21.1 --dry-run`→0；任务数 > 20；root 下无 `libraries/` |
| E2E-106 | 未验证依赖默认不装 | FO `--dry-run`→0；默认「没有需要自动补装」；加 `--include-unverified` 才出计划；目标目录未创建 |
| E2E-107 | MCP 预检 | `preflight_modpack(demo.mrpack)` 有 `structuredContent.verdict` |

### T2 真实下载（约 10 min，约 150 MB）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-201 | 原版安装幂等 | 连续两次 `setup 1.21.1`：第二次「下载 0 · 失败 0」；版本 JSON、client jar、实例标记都在 |
| E2E-202 | Fabric 加载器 | `fabric --loader --china`→0、失败 0；加载器版本 JSON 与实例标记落地 |

### T3 真实启动（约 5 min，需要 GPU 与窗口）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-301 | 正常进游戏 | `run fo --stop 60`→0；日志含 `Loading Minecraft 1.21.1` 与 `Loading N mods:`；会话日志落盘 |
| E2E-302 | Java 路径错误 | `--java <不存在>`→1；一句人话，不 spawn、不报「异常退出」 |
| E2E-303 | 版本不兼容被拦住 | 把 1.20.1 的 sodium 塞进 1.21.1 实例 → 预检 BLOCKED、`DEPENDENCY_VERSION_MISMATCH` |

### T4 故障注入（4 条，约 6 s）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-401 | sha1 不符 | 本地 HTTP 服务返回错误内容 + 生成的 mrpack：`deploy`→2、报 `hash mismatch`、`失败 1`、坏文件不落盘 |
| E2E-402 | 断网 | 死代理下预检 →1、`NETWORK_ERROR`、消息含失败的 URL、不说成「模组已下架」、30 s 内返回 |
| E2E-403 | 代理不可用 | `--proxy 127.0.0.1:9` →1、`NETWORK_ERROR` |

| E2E-404 | root 指向文件 | `--root <文件>` →1、「根目录不是文件夹」，不写半截目录 |

说明：真正的「只读目录」不测——Windows 的只读语义与 POSIX 不同，测出来大概率是平台怪癖；
SIGINT 中断由 `run.test.ts` 的 abort 用例覆盖。

## 4. 成本与执行

```bash
npm run e2e                  # 默认 T0+T1，约 1.5 min，不下载大文件
npm run e2e -- --tier 0      # 只跑离线
npm run e2e -- --only E2E-101
npm run e2e -- --list
```

T0–T4 已实现（39 条）。`--tier 2,3` 会真的下载、并打开一个游戏窗口
（E2E-301，默认 60 s，可用 `BP_E2E_STOP` 调短）；T4 只写 `/tmp` 与一个本地 HTTP 端口。

T2 之后会写盘、占用带宽、开游戏窗口，**不作为默认**。CI 跑 T0：夹具用
`scripts/make-*.mjs` 现造，没有大件的用例自动 SKIP（`--tier 2` 在 `CI=true` 下也会被拒绝）。

## 5. 缺陷与修复（2026-10-28）

实测抓出四条；修复与重型用例真实运行时又抓出七条同链路的。十一条全部已修，`knownIssue` 标记已删除。

| 编号 | 现象 | 修法 |
|---|---|---|
| `jij-false-positive` | FO 6.5.0 被报 BLOCKED：Puzzle/ModMenu 把 MidnightLib、Placeholder API 打在 JiJ 里，闭包只认顶层 projectId | 整合包模式降级为 `UNVERIFIED_DEPENDENCY` warning；安装项带 `confidence`，`install` 默认不装未验证项。见 ADR-0025 |
| `jar-lenient-json` | 2/48 真实 mod 的 `fabric.mod.json` 带裸换行，严格 `JSON.parse` 失败 | 解析失败后转义字符串内控制字符重试；嵌套 jar 同样处理 |
| `instance-no-version` | 自建实例不写版本元数据，只有 Prism 的 `mmc-pack.json` 能被读到 | `setup`/`fabric`/`deploy` 写 Prism 兼容的 `mmc-pack.json`，读取侧不变 |
| `launch-needs-network` | `setup` 不落 `versions/<id>/<id>.json`，`launch` 沿 `inheritsFrom` 只能联网 | `setup` 把版本 JSON 落盘，离线也能生成启动命令 |
| `fabric-meta-no-mirror` | `--china` 只镜像文件，`meta.fabricmc.net` 仍直连（这台机器 20 s 无响应） | 元数据也走 `bmclapi/fabric-meta`；`maven.fabricmc.net` 补进 BMCLAPI 映射 |
| `fabric-ignores-instance` | `fabric` 命令写死 `default` 实例，`--instance` 被忽略 | 解析 `--instance` 并写进 `layout` |
| `sha1-missing-silent` | 拿不到 sha1 的 loader 库被静默跳过，装出缺 loader 却报成功的实例 | 已存在的库不再探测；确实拿不到时计入 `failed`，退出码 2 |
| `stop-reported-as-crash` | `--stop` 到点由自己杀进程，却报「异常退出」并建议 diag | `RunResult.stopped`，主动结束不算崩溃，退出码 0 |
| `bad-java-path` | `--java` 指向不存在的文件时直接 spawn，报成「0 行日志的崩溃」 | `selectJava` 先检查存在性，给出「指定的 Java 不存在」 |
| `network-error-swallowed` | 断网时 `getVersions` 吞掉网络错误、逐个重试，产出 48 条「可能已下架」并 exit 0 | `NetworkError` 冒泡；预检报 `NETWORK_ERROR`，消息带地址与原因 |
| `opaque-fetch-error` | 所有出网失败只有 `TypeError: fetch failed`，不说是哪个地址 | 统一走 `http.ts` 的 `fetchJson()`，错误含 URL 与底层原因 |

前四条由 E2E 复现；后五条是修复与重型用例真实运行时暴露的。

### 5.1 第四轮（2026-11-06）：26.2 真实用户实测

完整记录见 `docs/testing/2026-11-06-real-user.md`（Modrinth 下载量第一的
FO 14.1.2 + MC 26.2，本机无 Java）。

| 编号 | 现象 | 修法 |
|---|---|---|
| `natives-split-layout` | 26.x 首次启动 `UnsatisfiedLinkError: lwjgl.dll`：JVM 参数指向 `natives/<ver>/java`，解压还在往根目录放 | 按版本 JSON 的 `${natives_directory}/java` 判定布局，LWJGL/JNA/Netty 分目录。见 ADR-0027 |
| `java-table-21` | 预检对 26.2 报「需要 Java 21」；只有 Java 21 的机器会被判为精确匹配、一条 finding 都没有 | `requiredJavaMajor` 只留一份，26.x → 25；hint 给 `java install 25` |
| `version-mismatch-direction` | 官方包被一个 7 KB 调试模组判 BLOCKED/exit 2（ADR-0026 停在 Proposed） | 落地 ADR-0026：高于声明 → `VERSION_UNVERIFIED` warning |
| `download-no-idle-timeout` | 半死连接让 `deploy` 永远停在 `23/51` | 连续 30 s 无字节即中止并换源 |
| `deploy-counts-resourcepacks` | 「模组 51 个」实际是 49 模组 + 2 资源包 | `files` 与 `mods` 分开计 |
| `deploy-java-without-version` | 选 Java 时不知道包要哪个版本，只有 Java 8 也会被选中 | 先读包里的 `gameVersion` 再选 |

单测 283 → 289，T0 15/15、T1 7/7。

当晚又补了两处（不属于缺陷，是可用性与契约）：

- `java install` 加 Adoptium 的 TUNA 镜像源，`--china` 时排第一。同一个 55.9 MB 的 JRE 25：
  GitHub 6–16 KB/s → 镜像 **7.3 s**。哈希仍按 Adoptium API 的 sha256 校验，镜像给错文件会被挡。
- `install` 的退出码改成只对「装」负责（0 = 没有要补的或全部装好，2 = 有文件失败），
  预检结论不再影响它；`E2E-106` 因此改回不带 `--no-host`，顺便钉住「没 Java 也能补模组」。

## 6. 不测什么

- **微软正版登录全流程**：缺 Azure 应用 id 与正版账号。只测未配置时的报错，以及单测里
  的令牌刷新逻辑。README 里那句「还没有一次真实登录的实测记录」继续有效。
- **CurseForge 安装**：没有 API key，真实安装不测。预检覆盖两条路：免 key 的 MCIM 镜像，
  以及 `--no-cf-mirror` 的降级结论（E2E-104）。
- **Linux / macOS 端到端**：本机没有。CI 的 ubuntu job 只跑单测，跨平台仍是纸面承诺。
- **显卡/驱动组合、多人联机、Modrinth 之外的内容源**：不在内核责任范围内。

## 7. 维护

- 新增一个真实样本（新加载器、新包）→ 加一条 T2 用例，别只写在 ADR 里。
- 日志类样本放 `testdata/`，不要放 `fixtures/`：后者是活的运行目录，会话日志只保留 10 份，
  跑几次 T3 就会把样本轮转掉（2026-10-29 真发生过一次）。
- 修掉一个 knownIssue → 删标记，用例转 PASS；`XPASS` 出现说明标记忘了删。
- 用例只断言**契约**（退出码、稳定字段、文件事实），不断言文案排版——否则改个措辞
  就要改测试，测试会先于产品腐烂。
