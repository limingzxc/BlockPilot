import { join } from 'node:path'
import { createCredentialStore } from '../../core/auth/credentials.js'
import {
  authStorePath,
  createLogin,
  DEVICE_AUTH_FALLBACK_URI,
  resolveClientId,
} from '../../core/auth/index.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { ROOT } from '../common-flags.js'
import { UsageError } from '../shared.js'
import { C, consume, say } from '../ui.js'

export const cmdLogin = defineCommand({
  name: 'login',
  summary: '用微软账号登录（设备码：给一个网址和一个短码，在浏览器里输）',
  flags: {
    '--root': ROOT,
    '--client-id': {
      takesValue: true,
      value: '<uuid>',
      help: '覆盖内置的 Azure 应用 id（一般不用传），也可用 BLOCKPILOT_CLIENT_ID',
    },
    '--timeout': {
      takesValue: true,
      value: '<秒>',
      help: '最多等多久；缺省等满设备码的 15 分钟',
    },
  },
  notes: ['内置 BlockPilot 自己的应用 id，直接跑就行；换自己的应用见 ADR-0039'],
  run: runLogin,
})

/**
 * 解析 --timeout。
 *
 * 存在的理由不是给玩家用的：设备码活 15 分钟，没人输码时进程就该退出并说清楚，
 * 而不是让调用方（脚本、代理）跟着干等 15 分钟。
 */
function parseTimeoutArg(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined
  if (!/^\d+$/.test(arg) || Number(arg) === 0) {
    throw new UsageError(
      'BAD_TIMEOUT',
      `--timeout 要一个正整数（单位秒），收到：${arg}`,
      '例：--timeout 60',
    )
  }
  return Number(arg) * 1000
}

export function runLogin(ctx: CommandContext): Promise<number> {
  const clientId = resolveClientId({
    flag: ctx.value('--client-id'),
    env: process.env.BLOCKPILOT_CLIENT_ID,
  })
  const timeoutMs = parseTimeoutArg(ctx.value('--timeout'))

  say('\n')
  say(`  ${C.bold}BlockPilot login${C.reset}  ${C.dim}微软账号 · 设备码${C.reset}\n\n`)

  return consume(
    createLogin({
      clientId,
      storePath: authStorePath(ctx.layout.root),
      credentials: createCredentialStore(join(ctx.layout.root, 'auth')),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    {
      log: (ev) => {
        if (ev.code === 'auth.device_code') {
          const d = ev.data
          const until = new Date(d.expiresAt).toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
          })
          say('\n')
          say(`  ${C.bold}1.${C.reset} 打开  ${C.cyan}${d.verificationUri}${C.reset}\n`)
          say(
            `  ${C.dim}   打不开（国内常见）就用备用地址  ${DEVICE_AUTH_FALLBACK_URI}${C.reset}\n`,
          )
          // 两张页面长得很像，标题是唯一一眼能分辨的差别；走错了只会得到「代码无法工作」
          say(
            `  ${C.dim}   它的标题应是 Microsoft account；写着 Sign in to your account 就是走错了${C.reset}\n`,
          )
          say(`  ${C.bold}2.${C.reset} 输入  ${C.bold}${d.userCode}${C.reset}\n\n`)
          say(`  ${C.dim}等待授权…（有效至 ${until}，Ctrl+C 取消）${C.reset}\n\n`)
          return
        }
        if (ev.code === 'auth.step') {
          const step = ev.data.step
          const text: Record<string, string> = {
            device_code: '申请设备码',
            waiting: '等待你在浏览器里完成授权',
            xbox: '换取 Xbox / Minecraft 令牌',
          }
          process.stderr.write(`${C.dim}· ${text[step] ?? step}${C.reset}\n`)
          return
        }
        process.stderr.write(`${C.dim}· ${ev.code}${C.reset}\n`)
      },
      exitCode: () => 0,
      result: (acc) => {
        say(`  ${C.green}登录成功${C.reset}  ${C.bold}${acc.name}${C.reset}\n`)
        say(`  ${C.dim}uuid ${acc.uuid}${C.reset}\n`)
        say(`  ${C.dim}令牌有效至 ${new Date(acc.expiresAt).toLocaleString()}${C.reset}\n\n`)
        return 0
      },
    },
    ctx.signal,
  )
}
