# 参与开发

给要改代码、加用例、写 ADR 的人。只想用的话看 [README.md](README.md) 就够了。

## 这是什么项目

一个**开源参考实现**，不是商业产品。目标是让别的启动器 / AI 客户端能直接复用这套分层与
协议，所以：

- 许可证必须宽松（MIT），不能掺 GPL 代码
- 依赖越少越好——参考实现的价值在于「能被读懂」，不是「功能多」
- 优先把边界写清楚（`core/` 只依赖 Node 内置 + undici + fflate），而不是堆特性

## 环境

```bash
npm install
npm run build      # tsc → dist/
npm run typecheck  # 只检查不产出
npm test           # 单元测试，全部离线
npm run e2e        # 实测，默认 T0 + T1
```

改了 CLI 行为先跑 `npm run build`——`e2e` 调的是 `dist/cli/index.js`，不是源码。

## 测试

**单测**（`src/**/*.test.ts`，`node:test` + `tsx`）：不联网、不写工作区，秒级。改任何
`core/` 模块都该带一条。

**实测**（`scripts/e2e.ts`）：只通过 `dist/cli/index.js` 和 MCP stdio 调用，断言退出码、
剥掉 ANSI 的文本、JSON 字段、文件系统事实。**不测文案排版**。

```bash
npm run e2e                # T0 离线 + T1 只读网络
npm run e2e -- --tier 0    # 只跑离线（CI 就是这条）
```

- 证据落在 `.tmp-e2e/<时间>/<用例>/`，每次调用的 args、退出码、stdout、stderr 都在里面
- 已知缺陷用 `knownIssue` 标记：失败记 KNOWN 不算红，修好变 XPASS 提示删标记
- T2–T4（真实下载 / 真启动 / 故障注入）已设计未实现

**夹具**：`fixtures/` 被 gitignore，靠脚本现造：

```bash
node scripts/make-fixture.mjs            # demo.mrpack / closure.mrpack
node scripts/make-instance-fixture.mjs   # instance-ok / instance-miss
```

`fixtures/mcroot` 这类大件（真实原版 jar、libraries）不在仓库里，依赖它的用例在干净环境
会记 SKIP，不是假红。

## 提交

- 一个提交解决一件事，标题 `type(scope): 中文短句`（`fix` / `feat` / `docs` / `test` / `chore`）
- body 写**为什么**和证据，不写「改了哪些文件」——那是 diff 的活
- 修 bug 的提交尽量带一条会红的用例
- 不跳过 hook，不 `--amend` 已推送的提交

## 设计决策

改行为之前先看 `docs/adr/`——那里解释了为什么某个看起来奇怪的选择是对的，比如：

- ADR-0025：整合包的「缺依赖」为什么只报 warning 不报 BLOCKED
- ADR-0026（Proposed）：版本不匹配该不该按方向分级

新增决策写成 ADR，格式照现有的来：Context / Decision / Consequences / Alternatives / 验证。

术语以 [GLOSSARY.md](GLOSSARY.md) 为准——「实例」「实例目录」「预检」「判定」这些词在代码
和文档里必须是同一个意思。

## CI

`.github/workflows/ci.yml`，Windows + Ubuntu 双平台：

```
npm ci → typecheck → test → 造夹具 → e2e --tier 0
```

注意：workflow 里给 `env` 写代理变量时**只能写一组大小写**。GitHub 校验 env 名不分大小写，
同时写 `HTTPS_PROXY` 和 `https_proxy` 会让整个 workflow 变成 `Invalid workflow file`，
而且表现为**零 job、创建与失败同一秒**——从日志里看不出任何线索，只能去 run 页面的
Annotations 里找。

## Issue

Issue 与 triage 标签的用法见 `docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`。
