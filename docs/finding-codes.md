# Finding 机器码

预检报告里每条 `Finding` 的 `code` 都是稳定机器码：文案可以改，码不能改。
它是 AI 的解释锚点，也是回归测试的断言对象。

这张表由 `src/core/preflight/codes.test.ts` 与 `FINDING_CODES` 对照，
新增一条结论必须同时改 `types.ts` 与这里。

| Code | 默认级别 | 含义 |
|---|---|---|
| `ASSETS_MISSING` | blocker / warning | 资源索引或对象缺失。1.19+ 会崩在标题画面；更早只影响声音 |
| `CF_NO_MOD_CHECK` | warning | CurseForge 清单的文件元数据没解析到，这次没做 mod 级校验 |
| `CLOSURE_TRUNCATED` | warning | 依赖闭包达到遍历上限被截断，结论只覆盖已访问的部分 |
| `CORRUPT_JAR` | warning | jar 不是完整的压缩包，加载器会因此启动失败 |
| `DECLARED_INCOMPATIBLE` | blocker | 两个模组互相声明不兼容，但都在实例里 |
| `DEPENDENCY_CYCLE` | warning | 依赖成环。多数加载器能容忍，通常意味着元数据有误 |
| `DEPENDENCY_VERSION_MISMATCH` | blocker | 本地依赖的版本不满足声明范围 |
| `DUPLICATE_MOD` | blocker | 同一个 modId 有多份 jar，加载器会拒绝启动 |
| `JAVA_INCOMPATIBLE_WITH_MOD` | blocker | 本机 Java 不满足模组自己声明的 `depends.java` 范围 |
| `JAVA_MISSING` | blocker | 本机没有目标大版本的 Java |
| `JAVA_NEWER_ONLY` | warning | 没有精确版本，但有更高的 Java；多数能跑 |
| `JAVA_OLDER_PRESENT` | info | 同时存在更低版本 Java，启动时要显式指定路径 |
| `JAVA_TOO_NEW` | blocker | 1.12 及更早只能用 Java 8，更高版本会在启动阶段死 |
| `LOADER_MISMATCH` | warning | 模组不支持当前加载器；这类 jar 会被加载器直接跳过，不影响启动 |
| `LOW_MEMORY` | warning | 物理内存与模组规模不匹配，启动时容易 OOM |
| `MISSING_DEPENDENCY` | blocker | 缺必需前置模组（已确认缺失，不是「可能内置」） |
| `NESTED_ONLY_JAR` | info | jar 没有顶层元数据，只有 jar-in-jar 子模组；子模组已计入索引 |
| `PACK_BUILTIN_MODS` | info | overrides/mods 里还有 jar，装完会一起参与校验 |
| `SERVER_ONLY_MOD` | warning | 声明为仅服务端的模组装在客户端，通常无意义 |
| `UNKNOWN_GAME_VERSION` | warning | 读不出实例的 MC 版本，版本相关结论不可靠 |
| `UNREADABLE_JAR` | info | jar 内的元数据读不出来，该模组未参与检查；资源包/非模组 jar 属正常情况 |
| `UNRESOLVED_MOD` | info | 拿不到这个模组的在线元数据，未参与检查 |
| `UNSATISFIABLE_DEPENDENCY` | blocker | 依赖存在，但找不到兼容当前 MC / 加载器的版本 |
| `UNVERIFIED_DEPENDENCY` | warning | 整合包里没看到依赖，但可能内置在某个 jar-in-jar 里 |
| `VERSION_MISMATCH` | blocker | 模组不支持目标 MC 版本（低于最低版本或落在声明缺口） |
| `VERSION_UNVERIFIED` | warning | 作者标注的版本列表里没有目标版本，可能只是没补勾 |
