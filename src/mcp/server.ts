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
import { dirname, join, resolve } from 'node:path'

import { applyProxy } from '../core/proxy.js'

import { createDiagnose } from '../core/diagnostics/index.js'
import type { DiagResult } from '../core/diagnostics/index.js'
import { createPreflight } from '../core/preflight/index.js'
import type { PreflightReport } from '../core/preflight/types.js'
import { ModrinthSource } from '../sources/modrinth.js'

const PREFLIGHT_TOOL = 'preflight_modpack'
const DIAG_TOOL = 'diagnose_crash'

// 环境变量里有代理就应用。失败不退出——没有代理 MCP 仍然可用
try {
  const applied = applyProxy()
  if (applied !== undefined) process.stderr.write(`[blockpilot] proxy ${applied}\n`)
} catch (err) {
  process.stderr.write(`[blockpilot] proxy ignored: ${String(err)}\n`)
}

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
  {
    name: DIAG_TOOL,
    title: '分析崩溃日志',
    description: [
      '读一份 Minecraft 崩溃日志，判断崩溃原因，并尽量指认到具体模组。只读文件，不改任何东西。',
      '',
      '返回两样东西：',
      '- primary：按规则匹配到的最可能根因（kind / 行号 / 人话解释 / 建议动作）',
      '- culprits：按证据强度排序的嫌疑模组，带判定依据（如「栈帧标明了来源 foo.jar」',
      '  「日志里点名了 foo.mixins.json」「包名属于它」）',
      '',
      '适用场景：用户贴了一份日志或问"为什么崩了"。优先用这个工具，不要靠肉眼读日志。',
      '',
      '重要约束：',
      '- culprits 为空时必须明确说"日志里定位不到具体模组"，绝对不要凭印象猜一个名字。',
      '  猜错会让用户去删一个无辜的模组，问题依旧而且多了一个新问题。',
      '- 多个 culprit 时，先说第一个，并说明依据；后面的只作为"也可能相关"。',
      '- 直接引用 hint，不要自己发明修复方案。',
      '- verdict=clean 表示日志里没有异常，不等于游戏没崩——可能是被外部杀掉或日志没写完。',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        logPath: {
          type: 'string',
          description:
            '日志文件路径，通常是 `<实例>/logs/latest.log` 或带时间戳的会话日志。**优先传绝对路径**。',
        },
        modsDir: {
          type: 'string',
          description:
            '可选。实例的 mods 目录，用于把栈帧归到具体模组。不传时按 `<日志目录>/../mods` 推断。',
        },
      },
      required: ['logPath'],
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

/** 崩溃分析的模型侧呈现。同样追求信息密度，而不是好看。 */
function renderDiagForModel(r: DiagResult): string {
  const head = `verdict=${r.verdict} lines=${r.lineCount} frames=${r.frameCount}`
  const lines: string[] = [head]

  if (r.primary !== null) {
    lines.push(`primary: ${r.primary.kind} @line ${r.primary.line}`)
    lines.push(`  message: ${r.primary.message}`)
    lines.push(`  hint: ${r.primary.hint}`)
  } else {
    lines.push('primary: 无')
  }

  if (r.culprits.length === 0) {
    lines.push('culprits: 无')
    for (const n of r.attributionNotes) lines.push(`  note: ${n}`)
  } else {
    lines.push('culprits（按证据强度排序）:')
    for (const c of r.culprits.slice(0, 5)) {
      const who = c.name === undefined ? c.modId : `${c.name} / ${c.modId}`
      lines.push(
        `  - ${who} ${c.version ?? ''} file=${c.fileName} frames=${c.frames} score=${c.score}`,
      )
      lines.push(`    reasons: ${c.reasons.join(' | ')}`)
      lines.push(`    frame: ${c.sampleFrame}`)
    }
  }

  const others = r.signals.filter((s) => s !== r.primary)
  if (others.length > 0) {
    lines.push('其他线索（可能是连锁反应）:')
    for (const s of others) lines.push(`  - ${s.kind} @line ${s.line}: ${s.hint}`)
  }

  return lines.join('\n')
}

const server = new Server(
  { name: 'blockpilot', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
  if (request.params.name === DIAG_TOOL) {
    const rawLog = request.params.arguments?.['logPath']
    if (typeof rawLog !== 'string' || rawLog.length === 0) {
      return {
        content: [{ type: 'text', text: 'missing required argument: logPath' }],
        isError: true,
      }
    }

    const logPath = resolve(rawLog)
    if (!existsSync(logPath)) {
      return { content: [{ type: 'text', text: `log not found: ${logPath}` }], isError: true }
    }

    // 日志默认在 `<实例>/logs/xxx.log`，所以 mods 目录是 `../mods`
    const rawModsDir = request.params.arguments?.['modsDir']
    const modsDir =
      typeof rawModsDir === 'string' && rawModsDir.length > 0
        ? resolve(rawModsDir)
        : join(dirname(dirname(logPath)), 'mods')

    const progressToken = request.params._meta?.progressToken
    const op = createDiagnose({ logPath, modsDir })

    try {
      for await (const ev of op.run(extra.signal)) {
        if (ev.type === 'progress' && progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: ev.done, total: ev.total, message: ev.label },
          })
        } else if (ev.type === 'log') {
          process.stderr.write(`[blockpilot] ${ev.code}\n`)
        } else if (ev.type === 'result') {
          const r = ev.value as DiagResult
          return {
            content: [{ type: 'text', text: renderDiagForModel(r) }],
            structuredContent: r as unknown as Record<string, unknown>,
          }
        } else if (ev.type === 'failed') {
          return { content: [{ type: 'text', text: `${ev.code}: ${ev.message}` }], isError: true }
        }
      }
      return { content: [{ type: 'text', text: 'diag finished without a result' }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: `diag crashed: ${String(err)}` }], isError: true }
    }
  }

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
