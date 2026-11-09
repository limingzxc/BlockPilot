/**
 * MCP 冒烟测试：真的起一个子进程，走 stdio 协议，列工具 + 调工具。
 * 用法：npx tsx scripts/mcp-smoke.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { strToU8, zipSync } from 'fflate'

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/mcp/server.ts'],
  cwd: process.cwd(),
  stderr: 'inherit',
})

const client = new Client({ name: 'blockpilot-smoke', version: '0.0.1' }, { capabilities: {} })

await client.connect(transport)
console.log('[smoke] connected')

const { tools } = await client.listTools()
console.log(
  '[smoke] tools:',
  tools.map((t) => t.name),
)

const result = await client.callTool({
  name: 'preflight_modpack',
  arguments: { path: 'fixtures/demo.mrpack' },
})

console.log('[smoke] isError =', result.isError === true)
for (const block of result.content as Array<{ type: string; text?: string }>) {
  if (block.type === 'text') console.log(`[smoke] text:\n${block.text}`)
}
console.log('[smoke] structuredContent present =', result.structuredContent !== undefined)

// ---- diagnose_crash：造一个带真 jar 的临时实例，验证栈帧归属能走通 ----
const tmp = mkdtempSync(join(tmpdir(), 'bp-smoke-'))
const modsDir = join(tmp, 'mods')
const logsDir = join(tmp, 'logs')
mkdirSync(modsDir, { recursive: true })
mkdirSync(logsDir, { recursive: true })

writeFileSync(
  join(modsDir, 'demo-mod-1.0.0.jar'),
  zipSync({
    'fabric.mod.json': strToU8(JSON.stringify({ id: 'demo-mod', version: '1.0.0', name: 'Demo' })),
    'com/demo/mod/Main.class': strToU8('x'),
  }),
)
const logPath = join(logsDir, 'latest.log')
writeFileSync(
  logPath,
  [
    'java.lang.RuntimeException: boom',
    '\tat net.minecraft.client.Minecraft.tick(Minecraft.java:1)',
    'Caused by: java.lang.NullPointerException: null',
    '\tat com.demo.mod.Main.boom(Main.java:42)',
  ].join('\n'),
)

const diag = await client.callTool({
  name: 'diagnose_crash',
  arguments: { logPath },
})
console.log('[smoke] diag isError =', diag.isError === true)
for (const block of diag.content as Array<{ type: string; text?: string }>) {
  if (block.type === 'text') console.log(`[smoke] diag text:\n${block.text}`)
}
console.log('[smoke] diag structuredContent present =', diag.structuredContent !== undefined)

rmSync(tmp, { recursive: true, force: true })

await client.close()
