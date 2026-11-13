import { ROOT } from '../command/common-flags.js'
import type { CommandContext } from '../command/context.js'
import { defineCommand } from '../command/define.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { removeSavedAccount, savedAccounts } from '../use-cases/auth.js'

export const cmdAccounts = defineCommand({
  name: 'accounts',
  summary: '列出已保存的账号；--remove 删掉一个',
  flags: {
    '--root': ROOT,
    '--remove': { takesValue: true, value: '<name|uuid>', help: '删掉这个账号' },
  },
  run: runAccounts,
})

export async function runAccounts(ctx: CommandContext): Promise<number> {
  const remove = ctx.value('--remove')

  say('\n')
  if (remove !== undefined) {
    const removed = removeSavedAccount(ctx, remove)
    say(
      removed
        ? `  ${C.green}已移除${C.reset}  ${remove}\n`
        : `  ${C.yellow}没有这个账号${C.reset}  ${remove}\n`,
    )
    say('\n')
    return removed ? 0 : 1
  }

  const { storePath, accounts, active: activeId } = savedAccounts(ctx)
  say(`  ${C.dim}${storePath}${C.reset}\n\n`)
  if (accounts.length === 0) {
    say(`  ${C.dim}还没有账号。跑一次 blockpilot login 会加一个。${C.reset}\n\n`)
    return 0
  }

  const now = Date.now()
  for (const a of accounts) {
    const current = a.uuid === activeId ? `${C.green}*${C.reset}` : ' '
    const state =
      a.expiresAt > now + 60_000
        ? `${C.dim}令牌有效${C.reset}`
        : `${C.yellow}令牌过期，启动时自动刷新${C.reset}`
    const refreshable = a.refreshToken === undefined ? `${C.red}不可刷新${C.reset}` : state
    say(`  ${current} ${C.bold}${a.name}${C.reset}  ${C.dim}${a.uuid}${C.reset}\n`)
    say(`     ${refreshable}\n`)
  }
  say('\n')
  return 0
}
