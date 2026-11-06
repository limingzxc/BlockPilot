# 0031. 老版本的库布局：OS 变体不能合并，原生库走 classifiers

- **Status**: Accepted
- **Date**: 2026-11-07
- **Deciders**: @liming
- **Depends on**: ADR-0007、ADR-0011、ADR-0027

## Context

RLCraft（1.12.2 + Forge）安装成功、部署后检查 OK，但一启动就死。两次报错，各对应一处
只在老版本出现的库布局：

### 1. `NoClassDefFoundError: org/lwjgl/opengl/Display`

1.12.2 的版本 JSON 里，同一个 `org.lwjgl.lwjgl:lwjgl` 有**两份**：

| 版本 | rules |
|---|---|
| 2.9.4-nightly-20150209 | `allow`（无 os）+ `disallow osx` |
| 2.9.2-nightly-20140822 | `allow osx` |

`libraryKey` 只按 `group:artifact:classifier` 去重，两份压成一份，后来者（2.9.2）赢。
到 Windows 上一过滤——2.9.2 只允许 osx，被丢掉；2.9.4 已经被合并没了。
classpath 里一个 lwjgl 都没有。

### 2. `UnsatisfiedLinkError: no lwjgl64 in java.library.path`

1.12.2 用的是老式 natives 声明：

```json
"natives": { "windows": "natives-windows" },
"downloads": { "classifiers": { "natives-windows": { "path": "...-natives-windows.jar" } } }
```

`buildVanillaTasks` 与 `extractNatives` 只看 `downloads.artifact`。原生 jar 从来没被下载，
natives 目录里只有 jinput / OpenAL，没有 `lwjgl64.dll`。

## Decision

1. `libraryKey` 把 **OS 变体**算进身份：取所有带 `os` 的 rule，拼成
   `action:osName:osArch`，附在 key 末尾。同一 artifact 的不同 OS 变体各留一份，
   `pickLibraries` 再按当前平台过滤；版本仍不进 key，加载器覆盖原版的行为不变。
2. 新增 `nativeArtifact(lib, env)`：
   - 有 `natives[env.os]` → 用 `downloads.classifiers[该 classifier]`；
   - 没有 → 退回 `downloads.artifact`（1.19+ 的写法）。
   下载任务与解压都用它。

## Consequences

**Positive**

- 1.12.2（以及同样带 OS 变体的老版本）能真正启动。实测 RLCraft 从 10 秒崩溃走到
  模组初始化阶段。
- 1.19+ 的路径完全不变，natives 拆分目录（ADR-0027）也不受影响。

**Negative**

- 合并后的库列表会比以前多几项（只有带 OS 规则的那些）。classpath 仍然只包含当前平台的一份。
- `libraryKey` 从「看名字」变成「看名字 + 规则」，测试里构造库对象要带 rules 才符合真实数据。

## Alternatives considered

| 方案 | 否决理由 |
|---|---|
| 去重时保留「规则允许当前平台」的那份 | `mergeVersionJson` 是纯函数，不知道目标平台；把平台传进去会污染合并层 |
| 把版本号加进 key | 会破坏「加载器的 asm 覆盖原版 asm」这条契约 |
| 只修 classifiers，不修合并 | lwjgl 主 jar 根本不在合并结果里，修了也没用 |
| 特判 1.12.2 | 布局差异来自 rules 与 classifiers，按数据判断比按版本号判断稳 |

## 验证

- `inherit.test.ts`：同一 artifact 的两个 OS 变体都保留；Windows 上 classpath 只出现 2.9.4。
- `natives.test.ts`：老式 classifiers（windows/linux）与 1.19+ artifact 两条路径。
- 真机：RLCraft 修复后 `run` 进入模组初始化（2300+ 行日志），不再在 10 秒内退出。
