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
| 真内存崩溃样本 | `testdata/instances/oom/logs/fabric-heap-space.log`（Fabric tinyremapper 堆空间不足，来自贴吧） |
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

用例优先级按**真实用户使用频率**排，而不是按模块排：

| 频率 | 用户场景 | 覆盖用例 |
|---|---|---|
| 每次游戏（最高） | 启动 / 只出启动命令 | E2E-301、E2E-010 / 010B、E2E-014、E2E-020、E2E-023 |
| 每个整合包一次 | 首次安装：deploy → assets → Java | E2E-205、E2E-110、E2E-203、E2E-201 / 202、E2E-003 / 004 / 101、E2E-033 |
| 偶发 | 预检说缺依赖 → 补装 | E2E-106、E2E-204、E2E-103 |
| 出问题时 | 崩溃归因 / 查日志 / 完整性 | E2E-006 / 007 / 008 / 016 / 028、E2E-009、E2E-012、E2E-015、E2E-302 / 303、E2E-030 / 031 / 032 / 034 / 035 |
| 维护 | 更新 / 配置 / 账号 / Java | E2E-108、E2E-017、E2E-018、E2E-024、E2E-019 / 021 |
| 边界与故障 | 坏参数 / 断网 / 坏包 | E2E-022、E2E-026、E2E-027、E2E-401~404、E2E-104、E2E-109 |

### 3.1 真实用户行为来源（2026-11-10）

这一轮用例不是按模块补的，是从贴吧与 B 站的玩家原帖/教程里抽取**行为**，
再折成可机器判定的契约。帖子链接只用于溯源，断言不依赖帖子内容。

| 玩家行为 | 来源 | 对应用例 |
|---|---|---|
| 同一个模组下了两次，mods/ 里两份 jar，启动器直接拒绝启动 | [B站《怎么看崩溃日志（二）》](https://www.bilibili.com/opus/755850554255605799) 第 1 类 | E2E-030 |
| 下载中断/杀软拦截，留下半个 jar，启动时报 `ZipException` | 同上第 11 类「安装不当」 | E2E-031 |
| 把 Fabric 模组装进 Forge 实例；Forge 里再塞 OptiFine | 同上第 1 类；[贴吧 RLCraft 帖](https://tieba.baidu.com/p/7650059312) | E2E-032 |
| 只装了版本没装 assets：能启动但没声音，1.19+ 崩在标题画面 | [B站《国际版正版和盗版重要吗?》](https://www.bilibili.com/opus/777782667316822085)；README「1.19 及以后必须安装 assets」 | E2E-033 |
| 开了版本隔离，却在通用目录找日志；把别的实例的日志发来求助 | [B站《怎么看崩溃日志（二）》](https://www.bilibili.com/opus/755850554255605799)「版本隔离」段 | E2E-034 |
| Fabric 大包内存不够，堆栈里全是 tinyremapper，误以为是模组冲突 | [贴吧 HMCL 帖](https://tieba.baidu.com/p/6498328050)；[B站《怎么看崩溃日志（入门）》](https://www.bilibili.com/opus/485246375773182129)「内存不足」段 | E2E-035 |
| 整合包装在中文/含空格目录，或把 mods 改成中文名 | [B站《怎么看崩溃日志（二）》](https://www.bilibili.com/opus/755850554255605799) 第 5 类 | 路径部分已有 E2E-025；改文件名不新增用例——那是加载器/启动器的行为，不是内核能修的 |
| 旧 Forge 配了过高的 Java，报 `InaccessibleObjectException` / `Unknown module` | [贴吧 PCL2 帖](https://tieba.baidu.com/p/8766954619) | 不重复建用例：`checkJava` 的 `JAVA_TOO_NEW` 单测 + E2E-303 已覆盖版本方向；E2E 需要控制本机 Java 列表，暂不引入 |
| 1.12.2 整合包「结束代码 0」但游戏没起来 | [贴吧 RLCraft 帖](https://tieba.baidu.com/p/7650059312) | 不重复建用例：退出码语义由 E2E-301 的「到点结束不算崩溃」钉住，真实窗口不适合放进 T0 |

### T0 离线（约 1 min，零网络）

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
| E2E-018 | 账号存档 | 空存档→0；形状不完整的条目被过滤；`--remove` 按名字（大小写不敏感）；不存在→1 |
| E2E-019 | `--events` | stdout 全是 JSON 行；含 `schemaVersion=1`；最后 `type=exit, code=2`；无 ANSI |
| E2E-020 | `config --jvm-args` 进启动命令 | 写入后 `launch` 输出含 `--add-opens` 与完整值，同时保留 `-Xmx2048M` |
| E2E-021 | `install --events` | stdout 全是 JSON；只有一个 `exit` 且在最后；无 ANSI |
| E2E-022 | `--stop` 非法值 | 退出码 1；稳定码 `BAD_STOP`，不把 NaN 交给 `setTimeout` |
| E2E-023 | `--events` 令牌 | 在线账号启动时 stdout 不含真实 token；`result.value.args` 里 `--accessToken` 为 `***` |
| E2E-024 | `java` 命令 | `java install` 缺参/非数字/低于 8 →1 且不联网；托管 JRE 能被扫描到（有夹具时） |
| E2E-025 | 空格与中文路径 | `config`→`launch`→`verify` 全链路；CJK 文件名、含空格路径、sha512 条目 |
| E2E-026 | 坏 lock / 坏配置 | 无 lock→1 `LOCK_NOT_FOUND`；坏 JSON / 版本不认识→1 `LOCK_CORRUPT`；`complete:false`→2 且 issues 为空；`CONFIG_CORRUPT` |
| E2E-027 | `--events` 失败路径 | 缺 target、未知命令、坏代理：stdout 仍只有 ndjson，有且仅有一个 `exit` |
| E2E-028 | diag 自动选证据 | `logs/` 混放时按 mtime 选最新；`primary.kind=mixin`，嫌疑人 controlify |
| E2E-029 | MCP 错误输入 | 非日志扩展名 / 不存在的日志与包 → `isError`；连续错误后服务仍能正常响应 |
| E2E-030 | 重复模组 | 两份同 modId 的 jar →2；`BLOCKED`；`DUPLICATE_MOD`；两份文件名都列出 |
| E2E-031 | 下载中断的半个 jar | →0；`CORRUPT_JAR`；不报 `MISSING_DEPENDENCY`、不判 BLOCKED |
| E2E-032 | Fabric 模组进 Forge 实例 | →0；`LOADER_MISMATCH`；说明会被跳过；不报缺依赖 |
| E2E-033 | 1.19+ 缺 assets | →2；`BLOCKED`；`ASSETS_MISSING`；提示 `blockpilot assets 1.20.1` |
| E2E-034 | 版本隔离下的日志归属 | 当前实例无日志→1；不读另一实例的日志，不点名其模组 |
| E2E-035 | 真实堆空间崩溃 | `OutOfMemoryError`→2；`out-of-memory`；建议含 `--memory`；不点名模组 |

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
| E2E-108 | `update` 只读检查 | 真实 lock 反查 Modrinth：`checked ≥ 40`，`applied` 为空，`lock.json` 字节不变 |
| E2E-109 | `deploy` slug 不存在 | →1；说清是 slug 查询失败；不创建 `instances/` |
| E2E-110 | `assets --dry-run` | 首次安装第二步：对象数 > 1000；不创建 `assets/objects/` |

### T2 真实下载（约 10 min，约 150 MB）

| ID | 场景 | 判定 |
|---|---|---|
| E2E-201 | 原版安装幂等 | 连续两次 `setup 1.21.1`：第二次「下载 0 · 失败 0」；版本 JSON、client jar、实例标记都在 |
| E2E-202 | Fabric 加载器 | `fabric --loader --china`→0、失败 0；加载器版本 JSON 与实例标记落地 |
| E2E-203 | `java install` | `java install 21 --china`→0；托管目录出现 `bin/java`；扫描能识别；第二次「已存在」且不重新下载 |
| E2E-204 | 真实补装依赖 | `install closure.mrpack --include-unverified` 下载 Sodium：哈希与 Modrinth 一致；第二次命中缓存 |
| E2E-205 | 同 root 再装实例 | deploy 复用原版/加载器；lock 与 overrides 落地；重跑不覆盖用户改动；`--overwrite-overrides` 才恢复；verify 通过 |

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

T0–T4 已实现（58 条）。`--tier 2,3` 会真的下载、并打开一个游戏窗口
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
