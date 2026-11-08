# 0034. diag 的 severity 跟结论走；损坏的 jar 单独归类

- **Status**: Accepted
- **Date**: 2026-11-08
- **Deciders**: @liming
- **Related**: ADR-0025

## Context

两个都是「归类错」的问题，症状相反：

**一、可恢复的 mixin 告警被判 fatal。** FO 6.5.0 正常进游戏、正常退出的日志里，
`InvalidMixinException: Found a remappable @Shadow annotation` 被标成
`severity: fatal`，而人话输出同一份结论写的是「日志里没有致命异常」。
`verdict` 侧用 `survivedAfter` 降级成了 `inconclusive`，信号本身的 severity 没跟着降——
脚本消费 `--json` 会当成崩溃，等于给所有 FO 用户每次 `diag` 都塞一条假崩溃。

**二、损坏的 jar 被说成缺前置。** 4 KB 随机字节写成 `mods/broken-mod-1.0.jar` 后，
日志第 17 行写得很清楚（`Error analyzing [...]: zip END header not found`），
但 `diag` 的第一条结论是 `missing-dependency`：因为 `ModResolutionException` 是 Fabric
「模组发现失败」的总出口，jar 读不出来也走那条路。用户照着提示去补依赖，永远修不好。

## Decision

1. Rule 增加 `recoverableWhen`：同一行（或向下两行，异常详情常换行）命中即把
   severity 降为 warning，并给信号打 `recoverable: true`。
2. 可恢复且结论不是 crash 时，`culprits` 置空并补一条 attribution note。
   Loader 已经把它处理掉了，点名只会让用户去删一个没问题的模组。
3. 同一个 kind 只报一次，但允许「可恢复 → 真致命」升级：
   日志里先出现降级变体、后来又真的崩了，留下的必须是后面那条。
4. 新增 `corrupt-jar` 规则，排在 `missing-dependency` **之前**；
   命中后从 `Error analyzing [<path>]` 里取文件名放进 `subject`，
   并把同日志里的 `missing-dependency` 去掉——它是结果，不是原因。
5. `preflight` 把「损坏」与「没有元数据」分开：`scan` 里用 `isCorruptZip`
   （`unzipSync` 只读中央目录）判定，损坏 → `CORRUPT_JAR` warning（删掉重下），
   其余没元数据的仍是 `UNREADABLE_JAR` info。RLCraft 有 11 个这种正常文件，
   一律提成 warning 会把真问题淹掉。

## Consequences

- `CrashSignal` 多两个可选字段（`subject` / `recoverable`），JSON 消费方按需读取。
- 心跳判定依赖「日志以栈帧收尾」：`endsWithStack` 只看最后一条非空行，
  异常头单独成行时也算。
