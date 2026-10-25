/**
 * MCP 冒烟测试：真的起一个子进程，走 stdio 协议，列工具 + 调工具。
 * 用法：npx tsx scripts/mcp-smoke.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

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
for (const block of result.content) {
  if (block.type === 'text') console.log('[smoke] text:\n' + block.text)
}
console.log('[smoke] structuredContent present =', result.structuredContent !== undefined)

await client.close()
