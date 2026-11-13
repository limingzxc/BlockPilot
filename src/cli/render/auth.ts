/**
 * 账号用例的渲染：离线/在线提示、认证失败、离线名警告。
 */

import { C } from '../output/ansi.js'
import type { AuthNotice } from '../use-cases/auth.js'

export function renderAuthNotice(notice: AuthNotice): void {
  if (notice.kind === 'online') {
    const note = notice.refreshed ? '（令牌已刷新）' : ''
    process.stderr.write(`${C.dim}· 账号 ${notice.name}${note}${C.reset}\n`)
    return
  }
  process.stderr.write(`${C.dim}· 离线模式：${notice.reason}${C.reset}\n`)
}

export function renderAuthFailure(failure: {
  readonly code?: string
  readonly message: string
  readonly hint?: string
}): void {
  const head = failure.code === undefined ? failure.message : `${failure.code}: ${failure.message}`
  process.stderr.write(`${C.red}${head}${C.reset}\n`)
  if (failure.hint !== undefined) process.stderr.write(`${C.dim}${failure.hint}${C.reset}\n`)
}

export function renderOfflineNameWarning(name: string): void {
  process.stderr.write(
    `${C.yellow}注意${C.reset}：离线用户名「${name}」不符合规则（仅字母/数字/下划线，1–16 位），联机会被拒\n` +
      `${C.dim}单人还能进；要联机请换成英文名，如 Steve${C.reset}\n`,
  )
}
