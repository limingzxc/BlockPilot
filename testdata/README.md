# testdata

给实测用例用的稳定样本。**不是** user fixture 目录（那个是 `fixtures/`，被 gitignore）。

## 为什么放这里

`fixtures/mcroot` 是活的运行目录：`run` 每次写一份会话日志，只保留最近 10 份。
2026-10-29 跑 E2E-301 时，2026-10-25 的真实崩溃日志被轮转删除，依赖它的用例直接失效。
测试样本不能长在会被业务逻辑回收的目录里。

## 内容

```
instances/crash/logs/controlify-mixin.log   真实崩溃日志的截取（mixin 注入失败）
instances/crash/mods/controlify-3.0.0.jar   仅含 fabric.mod.json 的极小 jar，用于栈帧归属
instances/auth/logs/auth-failed.log         真实日志原样拷贝（authlib 401）
instances/clean/logs/clean.log              真实日志原样拷贝（成功启动，无异常）
```

`crash` 的日志是**截取**：原始文件被轮转删除后，按当时 `diag` 输出里出现过的原文行重建，
只保留能触发 mixin 归因的部分。auth / clean 两份是原文件拷贝。

日志旁边的 `mods/` 是必需的——`diag` 用它把栈帧归属到具体模组；没有它只能报「定位不到」。
