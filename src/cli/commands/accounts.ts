import { join } from 'node:path'
import { createCredentialStore } from '../../core/auth/credentials.js'
import { authStorePath, loadStore, removeAccount } from '../../core/auth/index.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { ROOT } from '../common-flags.js'
import { C, say } from '../ui.js'

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
  const storePath = authStorePath(ctx.layout.root)
  const remove = ctx.value('--remove')

  say('\n')
  const credentials = createCredentialStore(join(ctx.layout.root, 'auth'))
  if (remove !== undefined) {
    const removed = removeAccount(storePath, remove, credentials)
    say(
      removed
        ? `  ${C.green}已移除${C.reset}  ${remove}\n`
        : `  ${C.yellow}没有这个账号${C.reset}  ${remove}\n`,
    )
    say('\n')
    return removed ? 0 : 1
  }

  const store = loadStore(storePath, credentials)
  say(`  ${C.dim}${storePath}${C.reset}\n\n`)
  if (store.accounts.length === 0) {
    say(`  ${C.dim}还没有账号。跑一次 blockpilot login 会加一个。${C.reset}\n\n`)
    return 0
  }

  const now = Date.now()
  for (const a of store.accounts) {
    const active = a.uuid === store.active ? `${C.green}*${C.reset}` : ' '
    const state =
      a.expiresAt > now + 60_000
        ? `${C.dim}令牌有效${C.reset}`
        : `${C.yellow}令牌过期，启动时自动刷新${C.reset}`
    const refreshable = a.refreshToken === undefined ? `${C.red}不可刷新${C.reset}` : state
    say(`  ${active} ${C.bold}${a.name}${C.reset}  ${C.dim}${a.uuid}${C.reset}\n`)
    say(`     ${refreshable}\n`)
  }
  say('\n')
  return 0
}
