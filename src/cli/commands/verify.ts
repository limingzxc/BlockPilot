import type { VerifyResult } from '../../core/instance/lock.js'
import { createVerify } from '../../core/instance/lock.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { INSTANCE, ROOT } from '../common-flags.js'
import { C, consume, say } from '../ui.js'

export const cmdVerify = defineCommand({
  name: 'verify',
  summary: '核对已装文件与 lock.json：缺了哪些、哪些哈希不符',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--json': '输出 JSON',
  },
  notes: ['lock.json 由 deploy 写入；手工装的实例没有它，会报 LOCK_NOT_FOUND'],
  run: runVerify,
})

export function renderVerify(r: VerifyResult, gameDir: string): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot verify${C.reset}`)
  lines.push('')
  lines.push(`  实例      ${gameDir}`)
  lines.push(
    `  清单      ${r.lock.files.length} 个文件 · ${r.lock.updatedAt} · ` +
      (r.lock.complete
        ? `${C.green}上次部署完整${C.reset}`
        : `${C.yellow}上次部署未完成${C.reset}`),
  )
  lines.push(
    `  核对      ${r.checked} 个 · ${C.green}通过 ${r.ok}${C.reset} · ` +
      (r.issues.length === 0
        ? `${C.green}无问题${C.reset}`
        : `${C.red}问题 ${r.issues.length}${C.reset}`),
  )
  lines.push('')

  const label: Record<VerifyResult['issues'][number]['reason'], string> = {
    missing: '文件不存在',
    mismatch: '哈希不符',
    unreadable: '读不了（路径不安全或权限）',
    'no-hash': '清单里没有哈希，无法校验',
  }
  const order: VerifyResult['issues'][number]['reason'][] = [
    'missing',
    'mismatch',
    'unreadable',
    'no-hash',
  ]
  for (const reason of order) {
    const group = r.issues.filter((i) => i.reason === reason)
    if (group.length === 0) continue
    lines.push(`${C.yellow}${label[reason]}${C.reset}  ${group.length} 个`)
    for (const i of group.slice(0, 10)) lines.push(`  ${C.dim}${i.path}${C.reset}`)
    if (group.length > 10) lines.push(`  ${C.dim}…还有 ${group.length - 10} 个${C.reset}`)
    lines.push('')
  }

  if (r.okAll) {
    lines.push(`${C.green}全部文件与清单一致${C.reset}`)
    lines.push('')
  } else if (r.issues.length === 0) {
    lines.push(`${C.yellow}文件都在，但上次部署没走完${C.reset}`)
    lines.push(`  ${C.dim}重跑一次 deploy 补齐失败项${C.reset}`)
    lines.push('')
  }
  return lines.join('\n')
}

export async function runVerify(ctx: CommandContext): Promise<number> {
  const layout = ctx.layout
  const asJson = ctx.has('--json')
  return consume(
    createVerify({ gameDir: layout.gameDir }),
    {
      progress: () => {},
      log: () => {},
      exitCode: (r) => (r.okAll ? 0 : 2),
      result: (r) => {
        if (asJson) {
          say(`${JSON.stringify(r, null, 2)}\n`)
        } else {
          say(renderVerify(r, layout.gameDir))
        }
      },
    },
    ctx.signal,
  )
}
