/**
 * 终端颜色与数值格式化。
 *
 * 纯函数 + 常量，没有状态、没有 I/O：渲染模块与消费器都可以安全依赖它。
 */

export const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
