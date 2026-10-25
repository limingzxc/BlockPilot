# 0010. 启动进程：游戏日志也是事件

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0007

## Context

命令拼对了，文件也齐了，最后一步是 `spawn`。看起来最简单，但有三件事必须想清楚：

1. 游戏的 stdout 是**唯一**的信息源，几千行日志怎么转成事件
2. 一行可能被切成两个 chunk，按 chunk 解析会得到半行
3. 退出码的语义——0 是正常，非 0 是被信号杀死还是崩溃

## Decision

### 1. stdin 设成 ignore

没有 TUI，留一个可写的 stdin 只会多占一个 fd。`stdio: ['ignore', 'pipe', 'pipe']`。

### 2. 跨 chunk 拼行

```ts
let buffer = ''
buffer += chunk.toString('utf8')
const lines = buffer.split(/\r?\n/)
buffer = lines.pop() ?? ''   // 最后一段可能是半行，留到下次
```

这是最容易被忽略的一点。不拼行的话，一条 `[Render thread/ERROR]: ...` 可能被拆成两条 log 事件，前半截还是 `[Render th`——排错时会让人怀疑人生。

### 3. 每行一个事件，level 用正则判

`Op.log(level, 'game.output', { stream, line })`。level 判断很简单：

```
/\b(ERROR|FATAL|Exception|Caused by)\b/
```

不解析 Minecraft 的日志格式（`[17:48:04] [Render thread/INFO]:`），因为它随版本和加载器变。宁可粗糙，不要脆。

### 4. 保留最后 40 行作为崩溃现场

全量日志走事件流，但另外留一个 `tail` 数组随结果返回。崩溃时用户要的是「最后发生了什么」，不是「从头开始翻 3000 行」。

上限 40 行是个经验值：够覆盖一次异常堆栈的开头，又不会把内存撑爆。

### 5. 不自动触发诊断

`launch` 崩溃后**不调用 preflight**。理由：`launch` 不该依赖 `preflight`，那是把两个独立能力绑死。

「崩溃后去诊断」是 **CLI 的策略**，所以 CLI 在 `crashed === true` 时打印下一步命令：

```
下一步
  blockpilot preflight "D:\BlockPilot\fixtures\mcroot\instances\default"
```

未来 GUI 可以做成一键，但那条决策属于 GUI 层。

### 6. `--stop <秒>` 只用于测试

自动 kill 是测试设施，不是产品功能。文档里明确标注。

## Consequences

**Positive**

- 日志成为事件流，CLI / GUI / MCP 可以各自决定怎么渲染（`--quiet` 只显示 ERROR 就是 CLI 的策略）。
- 崩溃现场（tail）随结果返回，不需要消费者自己缓冲。
- 退出码与信号分开记录，能区分「游戏自己崩了」和「被我们杀了」。

**Negative**

- **日志全量转发**。模组多的时候一分钟几千行，CLI 会被刷屏，`,`--quiet` 只是临时办法。
- 没有做日志存储，退出后 tail 之外的日志就没了。
- 没有处理游戏窗口的生命周期（最小化、崩溃对话框）。
- Windows 上 `child.kill()` 不保证杀干净子进程树。

## 实测

`blockpilot run 1.20.1 --root fixtures/mcroot --memory 2048 --stop 18`：

```
Setting user: Player
Backend library: LWJGL version 3.3.1 build 7
Reloading ResourceManager: vanilla
OpenAL initialized on device OpenAL Soft on 扬声器 (Realtek(R) Audio)
Sound engine started
Created: 1024x512x4 minecraft:textures/atlas/blocks.png-atlas
```

**OpenAL 和纹理图集都初始化成功**，说明 assets 装对了——这两步分别依赖音效文件和贴图文件，缺任何一个都会在这里报错。

已知的两个无害噪音：

- `Failed to verify authentication: Status 401` —— 离线模式传的是假 token，预期内
- `[LWJGL] Unsupported JNI version detected` —— Java 21 跑 1.20.1 的兼容性警告，官方推荐 17
