/**
 * MCP server —— 第二个 Consumer。
 *
 * 规矩：stdout 被协议独占，任何调试输出都必须走 stderr。
 * 这里不实现任何业务逻辑，只把 core 的 OpEvent 翻译成 MCP 的进度通知与工具返回。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { createPreflight } from '../core/preflight/index.js'
import type { PreflightReport } from '../core/preflight/types.js'
import { ModrinthSource } from '../sources/modrinth.js'

const PREFLIGHT_TOOL = 'preflight_modpack'

const tools: Tool[] = [
  {
    name: PREFLIGHT_TOOL,
    title: '预检整合包',
    description: [
      '检查一个 Minecraft 整合包或实例能否运行。不下载、不启动游戏、不登录账户。',
      '',
      '支持两种输入：',
      '- `.mrpack` 文件：会联网查 Modrinth 元数据，做递归依赖闭包，并给出可执行的修复计划',
      '- 实例目录：MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录。离线读 jar 内的',
      '  fabric.mod.json / mods.toml，只能判断「缺哪个 modId」，给不出下载地址',
      '',
      '适用场景：用户拿来一个整合包想知道能不能装；或者装完还没启动，想知道会不会崩。',
      '',
      '返回 verdict 四选一：',
      '- ok：检查通过',
      '- warn：能跑但有风险（如仅服务端模组装在客户端）',
      '- blocked：跑不了，findings 里有 blocker 级问题',
      '- unknown：有模组查不到元数据，结论不可靠',
      '',
      '重要：unknown 不等于 ok。看到 unknown 时，必须告诉用户"有 N 个模组没能校验"，',
      '不要说"没问题"。findings 里每条都带 code（稳定机器码）、message（人话）、hint（建议动作），',
      '直接引用 hint，不要自己发明修复方案。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            '整合包文件路径，支持 .mrpack。**优先传绝对路径**——server 的工作目录由启动它的客户端决定，相对路径容易解析到意外位置。',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

/** 把报告压成一段 AI 能直接读的文本。不追求好看，追求信息密度。 */
function renderForModel(report: PreflightReport): string {
  const head = `verdict=${report.verdict} mods=${report.stats.mods} resolved=${report.stats.resolved} unresolved=${report.stats.unresolved}`
  if (report.findings.length === 0) return `${head}\n无问题。`
  const body = report.findings
    .map((f) => {
      const parts = [`[${f.severity}] ${f.code}: ${f.message}`]
      if (f.hint !== undefined) parts.push(`  hint: ${f.hint}`)
      if (f.subject !== undefined) parts.push(`  subject: ${f.subject}`)
      return parts.join('\n')
    })
    .join('\n')
  return `${head}\n${body}`
}

const server = new Server(
  { name: 'blockpilot', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
  if (request.params.name !== PREFLIGHT_TOOL) {
    return {
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
      isError: true,
    }
  }

  const rawPath = request.params.arguments?.['path']
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return {
      content: [{ type: 'text', text: 'missing required argument: path' }],
      isError: true,
    }
  }

  const target = resolve(rawPath)
  if (!existsSync(target)) {
    return {
      content: [{ type: 'text', text: `target not found: ${target}` }],
      isError: true,
    }
  }

  const progressToken = request.params._meta?.progressToken
  const op = createPreflight({ target, source: new ModrinthSource() })

  try {
    for await (const ev of op.run(extra.signal)) {
      switch (ev.type) {
        case 'progress':
          if (progressToken !== undefined) {
            await extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: ev.done,
                total: ev.total,
                message: ev.label,
              },
            })
          }
          break
        case 'log':
          // stdout 不能碰，日志一律 stderr
          process.stderr.write(`[blockpilot] ${ev.code}\n`)
          break
        case 'result': {
          const report = ev.value as PreflightReport
          return {
            content: [{ type: 'text', text: renderForModel(report) }],
            structuredContent: report as unknown as Record<string, unknown>,
          }
        }
        case 'failed':
          return {
            content: [{ type: 'text', text: `${ev.code}: ${ev.message}` }],
            isError: true,
          }
        default:
          break
      }
    }
    return { content: [{ type: 'text', text: 'preflight finished without a result' }], isError: true }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `preflight crashed: ${String(err)}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[blockpilot] mcp server ready on stdio\n')
