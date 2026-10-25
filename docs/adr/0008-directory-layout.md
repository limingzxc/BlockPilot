# 0008. 目录布局：共享只读资源，隔离会被改动的东西

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0007

## Context

「安装目录」这个词其实混了两个概念：

| | 内容 | 特征 |
|---|---|---|
| **数据根** | `libraries/`、`assets/`、原版 jar | 只读、体积大（1–2 GB）、所有实例一样 |
| **实例** | `mods/`、配置、存档 | 会被改、每个实例不同 |

多数启动器把两者合成一个 `.minecraft`，结果是多开两个整合包时 mods 互相污染。反过来，每个实例复制一份完整目录，`assets` 就变成几 GB 的重复。

## Decision

### 1. 采用 Prism/MultiMC 的分层

```
<root>/                        用户只选这一次
  libraries/                   共享，几百 MB
  assets/                      共享，1–2 GB
  versions/<id>/<id>.jar       共享
  instances/<instanceId>/      每个实例独立
    natives/<versionId>/
    mods/
```

用户不需要给「每个实例」选目录——只选一次根，实例名由 `--instance` 派生。

### 2. 默认根目录放在用户数据区

| 平台 | 默认值 |
|---|---|
| Windows | `%APPDATA%\BlockPilot` |
| macOS | `~/Library/Application Support/BlockPilot` |
| Linux | `$XDG_DATA_HOME/blockpilot` 或 `~/.local/share/blockpilot` |

**不放程序所在目录**，两个理由：安装到 `Program Files` 时那里通常不可写；换个版本的程序就会丢掉整个游戏库。

### 3. `--root` 覆盖默认值，`--instance` 选实例

```bash
blockpilot setup  1.20.1 --root D:/mc
blockpilot launch 1.20.1 --root D:/mc --instance rlcraft
```

## Consequences

**Positive**

- 用户只需要做一次选择；之后所有路径自动派生。
- 多实例之间 `libraries` / `assets` 不重复，省几 GB。
- `Layout` 是一个纯数据对象，测试里可以随便换根目录，不碰真实磁盘。

**Negative**

- 比「一个 .minecraft 走天下」多一层概念，用户可能困惑「我的 mods 在哪」。需要在 UI 上直接显示 `gameDir`。
- 实例之间不能共享 mods（这是特性不是缺陷，但用户偶尔会想共享）。
- 卸载时 `instances/` 和 `libraries/` 的生命周期不同，需要分别提供清理入口。

## 影响到的既有代码

`buildLaunchPlan` 原本接受一个 `gameDir`，内部自己拼 `libraries` / `assets` / `versions`。改成接受 `Layout`——否则一旦布局变化，launch 和 setup 会各自拼各自的路径，迟早对不上。
