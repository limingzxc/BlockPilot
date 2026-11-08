/**
 * E2E 输出解析的纯函数。
 *
 * 放在这里而不是内联在 `case.run()` 里，是为了能单测：会话日志路径的断言
 * 曾经写成 `\S+`（空格路径必红），改成 `\s+` 又因为 `\s` 跨行把上一行的
 * 「N 行日志」接进路径——两次都只有真跑一遍游戏才能发现。
 */
export function extractLogPath(stdout: string): string | undefined {
  // 行首锚定 + 只吃空格/制表符：`\s` 会跨行，把上一行结尾的「行日志」并进来
  const m = /^\s*日志[ \t]+(.+?\.log)[ \t]*$/m.exec(stdout)
  return m?.[1]
}
