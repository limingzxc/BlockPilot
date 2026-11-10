/**
 * 版本号的唯一来源。
 *
 * 以前 `package.json`、`USER_AGENT`、MCP server、启动参数里的 `launcher_version`
 * 各写一份 `0.0.1`——升版本要记住四处，漏一处就会在日志或握手信息里暴露旧号。
 * 现在都从这里取，`version-info.test.ts` 校验它与 `package.json` 一致。
 *
 * 发版流程：`npm version <x.y.z>` 会改 `package.json` 与 lock，然后改这里的
 * `VERSION`（测试会提醒），再打 tag。
 */
export const VERSION = '0.1.0'
