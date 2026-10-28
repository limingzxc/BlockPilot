# 0025. 整合包的「缺依赖」只报 warning

- **Status**: Accepted
- **Date**: 2026-10-28
- **Deciders**: @liming
- **Depends on**: ADR-0003、ADR-0013

## Context

ADR-0003 把递归依赖闭包定为 `MISSING_DEPENDENCY` + `blocker`。2026-10-28 的实测推翻了
这个前提：

```
$ blockpilot preflight fixtures/fo-6.5.0.mrpack
  verdict   BLOCKED
  ✗ MISSING_DEPENDENCY  3IuO68q1 需要前置模组 codAaoxh，它不在实例中
  ✗ MISSING_DEPENDENCY  mOgUt4GM 需要前置模组 eXts2L7r，它不在实例中
```

而这两个「缺失」的依赖就在包里——被打在别的模组的 jar-in-jar 中：

```
puzzle-2.3.0.jar  → META-INF/jars/midnightlib-1.9.2+1.21.1-fabric.jar
modmenu-11.0.4.jar → META-INF/jars/placeholder-api-2.4.0-pre.2+1.21.jar
```

游戏日志显示 151 个模组正常加载。整合包作者是对的，检查是错的。

关键事实：**Modrinth 把 JiJ 依赖也标成 `required`**（实测这两个都是），而 `.mrpack`
里没有 jar，预检阶段无法证实它到底在不在。ADR-0003 假设「`embedded` 不进闭包」就能
避开这类情况——数据层面不成立。

## Decision

1. **整合包模式下的缺依赖是 `warning`，不是 `blocker`**，code 改为
   `UNVERIFIED_DEPENDENCY`，措辞是「包里没有它（可能已内置在某个模组里）」。
   理由与 ADR-0013 同源：没有证据就不能判违规。
2. **安装项带 `confidence`**（`verified` / `unverified`）。`blockpilot install` 默认
   只装 `verified`；要装未验证的加 `--include-unverified`。
   装一个重复的模组换不来任何好处，还可能改掉整合包作者选定的版本。
3. **默认 `verified`**，为将来留下「有 jar 可比对」的路径（例如对已装实例做闭包）。
   当前只有整合包会走闭包，所以实际输出全是 `unverified`。
4. **装完再确认**：实例目录里有 jar，`readModMetadata` 会读 `META-INF/jars/*` 与
   `provides`，离线预检能给出确定的结论。真正的缺失在那一步才报 `blocker`。

## Consequences

**Positive**

- 对真实整合包不再误报「跑不了」。这是本项目最不能犯的错——用户第一次用就撞上，
  只会认为工具坏了。
- 报告与安装动作对齐：warning 的东西不会被自动装进实例。
- 责任的边界清楚了：预检说「据我所知」，装完的离线检查说「我看到」。

**Negative**

- **`install` 不再是「一键补齐」**。整合包里真正缺的依赖，用户要多跑一次
  `preflight <实例>` 才能拿到确定的结论，再加 `--include-unverified` 装。
- `CLOSURE_TRUNCATED` 这类信息仍然只覆盖闭包展开的部分，不能当成「实例干净」的证明。
- ADR-0003 的验证样例（`closure.mrpack` 只装 Iris）现在输出 `WARN` 而不是 `BLOCKED`；
  闭包本身的单元测试保持原样（`closureToFindings` 默认仍是 verified）。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 下载依赖方的 jar 再查 `META-INF/jars` | 违反「预检不下载游戏文件」的承诺；为 48 个文件里的一两个再拉几百 KB，还把网络依赖带进纯检查 |
| 只读远端 zip 的中央目录（HTTP Range） | CDN 的 Range 支持不保证，ZIP64/重定向要处理；收益只覆盖这一种情况，复杂度不成比例 |
| 把 Modrinth 的 `required` 当 `embedded` 处理 | 会漏掉真正的缺失。数据不可信时，两种错都必须选一边，宁可漏报 |
| 保持 blocker，只在 hint 里加一句「可能在 JiJ 里」 | 退出码仍是 2、verdict 仍是 BLOCKED，脚本和用户的判断都被带偏 |

## 验证

- `scripts/e2e.ts` E2E-101 / E2E-102：真实 FO 6.5.0 不得出现 blocker，安装项必须是
  `unverified`；E2E-106：默认 `install` 不落盘、加 `--include-unverified` 才出计划。
- 离线实例预检（E2E-011/012）在 FO 实例上输出 `verdict OK`、48/48 resolved。
