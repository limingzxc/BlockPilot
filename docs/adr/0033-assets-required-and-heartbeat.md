# 0033. assets 是必装项；进程活着不等于游戏活着

- **Status**: Accepted
- **Date**: 2026-11-08
- **Deciders**: @liming
- **Related**: ADR-0026

## Context

README 曾写「assets 可以后补，不装也能进游戏」，FAQ 也只说「没声音、字体是方框」。
实测（1.21.1，只跑过 `setup`）：

```
[Render thread/ERROR]: Couldn't set icon
java.nio.file.NoSuchFileException: ...\assets\objects\5f\5ff04807...
```

日志停在开跑后第 12 秒，而 `--stop 45` 的时限是第 45 秒。三层判断因此全军覆没：

| 命令 | 输出 | 实际 |
|---|---|---|
| `run --stop` | 「已到时限结束」exit 0 | 游戏 33 秒前就死了 |
| `diag` | 「没有致命异常」inconclusive | 日志以栈帧收尾 |
| `preflight` | verdict OK | 3888 个对象一个都没有 |

三个根因都不是「少写一条检查」：

1. 1.19+ 的原版资源包**就是** assets，零资源时标题画面渲染直接抛异常——不是「没声音」。
2. launch 前的「文件不齐」只验 `assets/indexes/<id>.json`。index 是 `setup` 下的，
   objects 要单独跑 `blockpilot assets`，所以这道闸门永远通不过它该拦的东西。
3. `--stop` 到点是我们自己 kill 的，`stopped=true` 让 `crashed` 恒为 false。
   没有 `--stop` 时更糟：JVM 不退出，`run` 就一直挂着。

## Decision

1. `probeAssetObjects(indexPath, objectsDir, sample)`：按 index 去重后**等距抽 24 个**
   hash 查存在性。全量 stat 要几百毫秒，抽查已足够区分「装过」和「没装」。
2. `LaunchPlan.assets` 带上抽查结果；`run` 在启动前打一条 warning（不阻断——
   部分缺失常常只影响个别音效）。
3. `preflight` 新增 `ASSETS_MISSING`：一个对象都没有 → blocker（必崩）；
   部分缺失 → warning。没有 `assets/indexes` 目录时**不报**，别人的安装不归我们管。
4. `run` 用心跳判死：最后一行日志距今 ≥20 秒，且日志以栈帧收尾 → `diedBeforeStop`，
   `stopped` 置 false、`crashed` 置 true，CLI 明说「游戏在中途就停了」。
5. README 与 usage 改口径：「1.19+ 必装」。

## Consequences

- 抽查是启发式的：装了一半且恰好抽到的 24 个都在，会漏报。用 `--stop` 判死同理——
  安静的整合包若恰好以异常行收尾可能误判，所以两条判据必须同时成立。
- `RunResult` 多一个 `diedBeforeStop`；`LaunchPlan` 多一个 `assets`，构造它的测试要补。
