#!/usr/bin/env node
/**
 * BlockPilot 实测执行器（E2E）。
 *
 * 设计、判定原则与用例表在 docs/testing/real-tests.md。这里只说实现约束：
 *
 * - 只走公开入口：dist/cli/index.js 与 dist/mcp/server.js。用户装到机器上跑的就是它们。
 * - 断言的是契约：退出码、稳定机器码（MISSING_DEPENDENCY 等）、JSON 字段、文件事实。
 *   不断言文案排版，否则改个措辞就要改测试。
 * - T0 用死代理（127.0.0.1:9）跑，任何偷偷发请求的实现当场暴露。
 * - 已知缺陷标 knownIssue：失败记 KNOWN，修好后变 XPASS 提醒删标记。
 *
 * 用法：
 *   npm run e2e                      # T0 + T1，约 1.5 分钟
 *   npm run e2e -- --tier 0          # 只跑离线
 *   npm run e2e -- --only E2E-101    # 跑单条
 *   npm run e2e -- --list
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { strToU8, zipSync } from 'fflate'

const REPO = resolve(import.meta.dirname, '..')
const CLI = join(REPO, 'dist', 'cli', 'index.js')
const MCP = join(REPO, 'dist', 'mcp', 'server.js')
const FIX = join(REPO, 'fixtures')
const MCROOT = join(FIX, 'mcroot')

/**
 * 日志样本放在 testdata/ 而不是 fixtures/：后者被 gitignore，而且是活的运行目录——
 * 会话日志只保留最近 10 份，跑几次 E2E-301 就会把真实崩溃样本轮转掉（确实发生过）。
 */
const TESTDATA = join(REPO, 'testdata', 'instances')
const FO_CRASH_LOG = join(TESTDATA, 'crash', 'logs', 'controlify-mixin.log')
const AUTH_FAIL_LOG = join(TESTDATA, 'auth', 'logs', 'auth-failed.log')
const CLEAN_LOG = join(TESTDATA, 'clean', 'logs', 'clean.log')

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;]*m/g

/** 终端里带颜色，重定向到文件时也带。断言前统一剥掉。 */
function strip(text: string): string {
  return text.replace(ANSI, '')
}

export interface RunResult {
  readonly cmd: string
  readonly args: readonly string[]
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly ms: number
}

interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  shell?: boolean
}

function exec(bin: string, args: readonly string[], opts: ExecOptions = {}): Promise<RunResult> {
  const started = Date.now()
  return new Promise<RunResult>((resolvePromise) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd ?? REPO,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout += d
    })
    child.stderr.on('data', (d: string) => {
      stderr += d
    })

    let timer: NodeJS.Timeout | undefined
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        stderr += `\n[e2e] 超时 ${opts.timeoutMs}ms，已强杀\n`
        child.kill('SIGKILL')
      }, opts.timeoutMs)
    }

    const finish = (code: number | null): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolvePromise({
        cmd: bin,
        args,
        code,
        stdout,
        stderr,
        ms: Date.now() - started,
      })
    }

    child.on('error', (err) => {
      stderr += `\n[e2e] spawn 失败: ${String(err)}\n`
      finish(null)
    })
    child.on('close', (code) => {
      finish(code)
    })
  })
}

class AssertError extends Error {}

function fail(msg: string): never {
  throw new AssertError(msg)
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg)
}

function snippet(r: RunResult, lines = 12): string {
  const text = strip(`${r.stdout}\n${r.stderr}`).trimEnd().split('\n')
  const tail = text.slice(Math.max(0, text.length - lines)).join('\n')
  return `\n--- 最后 ${Math.min(lines, text.length)} 行 ---\n${tail}\n-------------------------`
}

function assertCode(r: RunResult, code: number, label: string): void {
  if (r.code !== code) fail(`${label}：退出码 ${String(r.code)}，期望 ${code}${snippet(r)}`)
}

function assertText(r: RunResult, needle: string | RegExp, label: string): void {
  const text = strip(`${r.stdout}\n${r.stderr}`)
  const ok = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
  if (!ok) fail(`${label}：输出里没有 ${String(needle)}${snippet(r)}`)
}

function assertMatch(text: string, re: RegExp, label: string): void {
  if (!re.test(text)) fail(`${label}：没有匹配 ${String(re)}`)
}

function assertNoText(r: RunResult, needle: string | RegExp, label: string): void {
  const text = strip(r.stdout)
  const hit = typeof needle === 'string' ? text.includes(needle) : needle.test(text)
  if (hit) fail(`${label}：不应该出现 ${String(needle)}${snippet(r)}`)
}

function parseJson(r: RunResult, label: string): Record<string, unknown> {
  try {
    return JSON.parse(r.stdout) as Record<string, unknown>
  } catch (err) {
    fail(`${label}：stdout 不是合法 JSON（${String(err)}）${snippet(r)}`)
  }
}

function asNumber(v: unknown, label: string): number {
  if (typeof v !== 'number') fail(`${label}：期望 number，实际 ${typeof v}`)
  return v
}

function asArray(v: unknown, label: string): unknown[] {
  if (!Array.isArray(v)) fail(`${label}：期望数组，实际 ${typeof v}`)
  return v
}

function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(`${label}：期望对象，实际 ${typeof v}`)
  }
  return v as Record<string, unknown>
}

/** T0 用的死代理：指向一个没人监听的端口，任何请求都会立刻 ECONNREFUSED。 */
const DEAD_PROXY = 'http://127.0.0.1:9'

function offlineEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HTTPS_PROXY: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    https_proxy: DEAD_PROXY,
    http_proxy: DEAD_PROXY,
  }
}

interface MmcMarker {
  readonly components?: readonly { readonly uid?: string; readonly version?: string }[]
}

function readMarker(gameDir: string): MmcMarker {
  return JSON.parse(readFileSync(join(gameDir, 'mmc-pack.json'), 'utf8')) as MmcMarker
}

function markerComponent(marker: MmcMarker, uid: string): string | undefined {
  return marker.components?.find((c) => c.uid === uid)?.version
}

/**
 * 每条用例依赖的夹具。CI 上 `fixtures/` 不存在（被 gitignore），
 * 这里列出来的用例记为 SKIP——不能因为「本机没有 1.7 GB 的实测目录」就假红。
 */
const REQUIRES: Readonly<Record<string, readonly string[]>> = {
  'E2E-003': [join(FIX, 'instance-miss')],
  'E2E-004': [join(FIX, 'instance-ok')],
  'E2E-005': [join(FIX, 'instance-miss')],
  'E2E-007': [AUTH_FAIL_LOG],
  'E2E-008': [CLEAN_LOG],
  'E2E-009': [MCROOT],
  'E2E-010': [MCROOT],
  'E2E-010B': [MCROOT],
  'E2E-011': [MCROOT],
  'E2E-012': [MCROOT],
  'E2E-101': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-102': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-103': [join(FIX, 'real-pack.mrpack')],
  'E2E-104': [join(FIX, 'cf-pack.zip')],
  'E2E-106': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-107': [join(FIX, 'demo.mrpack')],
  'E2E-201': [MCROOT],
  'E2E-202': [MCROOT],
  'E2E-301': [MCROOT],
  'E2E-302': [MCROOT],
  'E2E-303': [MCROOT],
  'E2E-401': [MCROOT],
  'E2E-402': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-403': [join(FIX, 'fo-6.5.0.mrpack')],
}

interface CliOptions {
  /** 默认：T0 用死代理，T1 继承真实环境 */
  offline?: boolean
  timeoutMs?: number
  cwd?: string
}

class Ctx {
  readonly tmp: string
  readonly dir: string
  private step = 0

  constructor(
    readonly caseId: string,
    evidenceRoot: string,
  ) {
    this.dir = join(evidenceRoot, caseId)
    mkdirSync(this.dir, { recursive: true })
    this.tmp = mkdtempSync(join(tmpdir(), `bp-e2e-${caseId}-`))
  }

  async cli(args: readonly string[], opts: CliOptions = {}): Promise<RunResult> {
    const r = await this.record('node dist/cli/index.js', process.execPath, [CLI, ...args], {
      timeoutMs: opts.timeoutMs ?? 120_000,
      env: opts.offline === true ? offlineEnv() : process.env,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    })
    return r
  }

  async cmd(bin: string, args: readonly string[], opts: ExecOptions = {}): Promise<RunResult> {
    return this.record(bin, bin, args, { timeoutMs: 120_000, ...opts })
  }

  private async record(
    label: string,
    bin: string,
    args: readonly string[],
    opts: ExecOptions,
  ): Promise<RunResult> {
    this.step += 1
    const r = await exec(bin, args, opts)
    const name = `${String(this.step).padStart(2, '0')}-${label.replace(/[^\w.-]+/g, '_')}.txt`
    writeFileSync(
      join(this.dir, name),
      [
        `$ ${label} ${args.join(' ')}`,
        `cwd: ${opts.cwd ?? REPO}`,
        `exit: ${String(r.code)}  ${r.ms}ms`,
        '',
        '--- stdout ---',
        strip(r.stdout),
        '--- stderr ---',
        strip(r.stderr),
        '',
      ].join('\n'),
      'utf8',
    )
    return r
  }
}

interface CaseDef {
  readonly id: string
  readonly title: string
  readonly tier: number
  /** 已知缺陷编号（docs/testing/real-tests.md §5）。失败记 KNOWN，通过记 XPASS */
  readonly knownIssue?: string
  run(ctx: Ctx): Promise<void>
}

// ---------------------------------------------------------------------------
// MCP 客户端（T0-013 / T1-107）
// ---------------------------------------------------------------------------

async function withMcp(fn: (call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>, tools: string[]) => Promise<void>): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP],
    cwd: REPO,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', () => {})

  const client = new Client({ name: 'blockpilot-e2e', version: '0.0.1' }, { capabilities: {} })

  const guard = setTimeout(() => {
    void client.close()
  }, 90_000)

  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await client.callTool({ name, arguments: args })
      return res as unknown as Record<string, unknown>
    }
    await fn(call, names)
  } finally {
    clearTimeout(guard)
    await client.close()
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const CASES: readonly CaseDef[] = [
  // ---------------- T0 离线 ----------------
  {
    id: 'E2E-001',
    title: '入口契约：help / 未知命令 / 无参',
    tier: 0,
    async run(ctx) {
      const help = await ctx.cli(['--help'], { offline: true })
      assertCode(help, 0, '--help')
      for (const cmd of [
        'preflight',
        'install',
        'java',
        'login',
        'accounts',
        'setup',
        'assets',
        'fabric',
        'deploy',
        'launch',
        'run',
        'logs',
        'diag',
      ]) {
        assertText(help, cmd, `--help 应列出 ${cmd}`)
      }

      const unknown = await ctx.cli(['nosuchcommand'], { offline: true })
      assertCode(unknown, 1, '未知命令')
      assertText(unknown, 'BlockPilot', '未知命令也应打印用法')

      const empty = await ctx.cli([], { offline: true })
      assertCode(empty, 0, '无参')
    },
  },
  {
    id: 'E2E-002',
    title: '构建产物可运行（bin 指向 dist）',
    tier: 0,
    async run(ctx) {
      assert(existsSync(CLI), `dist 入口不存在：${CLI}（先 npm run build）`)
      const r = await ctx.cmd(process.execPath, [CLI, '--help'], { timeoutMs: 30_000 })
      assertCode(r, 0, 'node dist/cli/index.js --help')
      assertText(r, 'preflight', 'dist 入口应打印用法')
    },
  },
  {
    id: 'E2E-003',
    title: '离线预检：缺依赖必须 BLOCKED',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'instance-miss'), '--no-host'], {
        offline: true,
      })
      assertCode(r, 2, 'instance-miss')
      assertText(r, 'BLOCKED', 'verdict')
      assertText(r, 'MISSING_DEPENDENCY', 'finding code')
      assertText(r, 'sodium', '缺的依赖')
    },
  },
  {
    id: 'E2E-004',
    title: '离线预检：unknown 不能当违规',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'instance-ok'), '--no-host'], {
        offline: true,
      })
      assertCode(r, 0, 'instance-ok')
      assertText(r, 'UNKNOWN', 'verdict')
      assertNoText(r, 'BLOCKED', 'unknown 不应升级成 blocked')
    },
  },
  {
    id: 'E2E-005',
    title: 'JSON 报告契约',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(
        ['preflight', join(FIX, 'instance-miss'), '--no-host', '--json'],
        { offline: true },
      )
      assertCode(r, 2, 'instance-miss --json')
      const j = parseJson(r, '--json')

      assert(j['verdict'] === 'blocked', `verdict 期望 blocked，实际 ${String(j['verdict'])}`)
      const findings = asArray(j['findings'], 'findings')
      assert(findings.length > 0, 'findings 不应为空')
      for (const f of findings) {
        const item = asRecord(f, 'finding')
        for (const key of ['severity', 'code', 'message']) {
          assert(typeof item[key] === 'string', `finding.${key} 应为 string`)
        }
      }

      const stats = asRecord(j['stats'], 'stats')
      assert(asNumber(stats['mods'], 'stats.mods') === 2, 'stats.mods 期望 2')
      assert(asNumber(stats['resolved'], 'stats.resolved') === 1, 'stats.resolved 期望 1')

      const plan = asRecord(j['plan'], 'plan')
      assert(asArray(plan['installs'], 'plan.installs').length === 0, '离线计划应为空')
      asArray(plan['manual'], 'plan.manual')

      const at = j['generatedAt']
      assert(typeof at === 'string' && !Number.isNaN(Date.parse(at)), 'generatedAt 应是 ISO 时间')
    },
  },
  {
    id: 'E2E-006',
    title: '真实崩溃归因：controlify mixin',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['diag', '--file', FO_CRASH_LOG], { offline: true })
      assertCode(r, 2, 'diag 崩溃日志')
      assertText(r, 'mixin', '根因类型')
      assertText(r, 'controlify', '第一嫌疑模组')
      assertText(r, /个栈帧/, '应给出栈帧数')
    },
  },
  {
    id: 'E2E-007',
    title: '真实登录失败归因：authlib 401',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['diag', '--file', AUTH_FAIL_LOG], { offline: true })
      assertCode(r, 0, 'auth-failed 不是崩溃退出')
      assertText(r, 'auth-failed', '根因类型')
      assertText(r, 'login', 'hint 应指向 login')
    },
  },
  {
    id: 'E2E-008',
    title: '干净日志不误报',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['diag', '--file', CLEAN_LOG], { offline: true })
      assertCode(r, 0, 'diag 干净日志')
      assertText(r, '没有在日志里找到异常', 'clean verdict')
    },
  },
  {
    id: 'E2E-009',
    title: '日志清单',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['logs', '--root', MCROOT, '--instance', 'fo'], { offline: true })
      assertCode(r, 0, 'logs')
      assertText(r, 'latest.log', '应有游戏原生 latest.log')
      assertText(r, /\[游戏原生\]/, '应标注游戏原生日志')
      const entries = strip(r.stdout)
        .split('\n')
        .filter((l) => /\.log\s/.test(l) || /\.log\b/.test(l))
      assert(entries.length >= 2, `日志条目应 ≥ 2，实际 ${entries.length}`)
    },
  },
  {
    id: 'E2E-010',
    title: 'launch 只出命令，不启动',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(
        ['launch', 'fabric-loader-0.19.3-1.21.1', '--root', MCROOT, '--instance', 'fo', '--raw'],
        { timeoutMs: 60_000 },
      )
      assertCode(r, 0, 'launch --raw')
      assertText(r, 'net.fabricmc.loader.impl.launch.knot.KnotClient', '主类')
      assertText(r, '-cp ', '类路径')
      assertText(r, '所有依赖文件都在位', '完整性结论')
      assert(r.ms < 60_000, `只打印不该超过 60s，实际 ${r.ms}ms`)
    },
  },
  {
    id: 'E2E-010B',
    title: '断网也能生成启动命令（文件齐全时）',
    tier: 0,
    async run(ctx) {
      // 文件全在 fixtures/mcroot 里，launch 只该读本地。死代理把它们变成「不许联网」。
      const r = await ctx.cli(
        ['launch', 'fabric-loader-0.19.3-1.21.1', '--root', MCROOT, '--instance', 'fo', '--raw'],
        { offline: true, timeoutMs: 60_000 },
      )
      assertCode(r, 0, 'launch --raw 断网')
      assertText(r, '所有依赖文件都在位', '完整性结论')
    },
  },
  {
    id: 'E2E-011',
    title: '真实 mod jar 必须全部可读',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(
        ['preflight', join(MCROOT, 'instances', 'fo'), '--no-host', '--json'],
        { offline: true },
      )
      const j = parseJson(r, 'FO 实例 --json')
      const findings = asArray(j['findings'], 'findings').map((f) => asRecord(f, 'finding'))
      const unreadable = findings.filter((f) => f['code'] === 'UNREADABLE_JAR')
      if (unreadable.length > 0) {
        fail(
          `有 ${String(unreadable.length)} 条 UNREADABLE_JAR：` +
            `${String(unreadable[0]?.['message'] ?? '')} / ${String(unreadable[0]?.['hint'] ?? '')}`,
        )
      }
      const stats = asRecord(j['stats'], 'stats')
      assert(asNumber(stats['mods'], 'stats.mods') === 48, 'stats.mods 期望 48')
    },
  },
  {
    id: 'E2E-012',
    title: '自建实例应能识别游戏版本',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(MCROOT, 'instances', 'fo'), '--no-host'], {
        offline: true,
      })
      assertCode(r, 0, 'preflight 自建实例')
      assertNoText(r, 'UNKNOWN_GAME_VERSION', '自己 deploy 出来的实例不该缺版本信息')
    },
  },
  {
    id: 'E2E-013',
    title: 'MCP stdio：工具清单与崩溃归因',
    tier: 0,
    async run(ctx) {
      await withMcp(async (call, tools) => {
        assert(
          tools.join(',') === 'diagnose_crash,preflight_modpack',
          `工具清单期望 [diagnose_crash, preflight_modpack]，实际 [${tools.join(', ')}]`,
        )
        const res = await call('diagnose_crash', { logPath: FO_CRASH_LOG })
        assert(res['isError'] !== true, 'diagnose_crash 不应 isError')
        const structured = asRecord(res['structuredContent'], 'structuredContent')
        assert(structured['verdict'] === 'crash', `verdict 期望 crash，实际 ${String(structured['verdict'])}`)
        const culprits = asArray(structured['culprits'], 'culprits')
        assert(culprits.length > 0, 'culprits 不应为空')
        const first = asRecord(culprits[0], 'culprit')
        assert(first['modId'] === 'controlify', `第一嫌疑期望 controlify，实际 ${String(first['modId'])}`)
      })
    },
  },

  {
    id: 'E2E-014',
    title: '--memory 非法值给稳定码，不把 -XmxNaNM 丢给 JVM',
    tier: 0,
    async run(ctx) {
      // 用户会照教程填 8192，也会手滑填 abc / -1 / 0。以前这些值原样拼成
      // `-XmxNaNM` 传给 JVM，用户看到的是 `Unrecognized option`，联想不到是自己写错
      //
      // 参数校验发生在任何 I/O 之前，所以这一组不依赖 fixtures 里的大件
      for (const bad of ['abc', '-1', '0', '999999']) {
        const r = await ctx.cli(
          [
            'launch',
            'fabric-loader-0.19.3-1.21.1',
            '--root',
            MCROOT,
            '--instance',
            'fo',
            '--memory',
            bad,
          ],
          { timeoutMs: 30_000 },
        )
        assertCode(r, 1, `--memory ${bad}`)
        assertText(r, 'BAD_MEMORY', '稳定错误码')
      }

      // 合法值要真生成启动命令，只有本机有 mcroot 时才验（CI 上会跳过这一段）
      if (!existsSync(MCROOT)) return
      const ok = await ctx.cli(
        ['launch', 'fabric-loader-0.19.3-1.21.1', '--root', MCROOT, '--instance', 'fo', '--memory', '4096'],
        { timeoutMs: 60_000 },
      )
      assertCode(ok, 0, '--memory 4096')
      assertText(ok, '-Xmx4096M', '内存参数')
    },
  },

  // ---------------- T1 只读网络 ----------------
  {
    id: 'E2E-101',
    title: '真实 FO 6.5.0 必须判定为能跑',
    tier: 1,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'fo-6.5.0.mrpack'), '--no-host', '--json'], {
        timeoutMs: 180_000,
      })
      const j = parseJson(r, 'FO --json')
      const verdict = j['verdict']
      assert(verdict === 'ok' || verdict === 'warn', `verdict 期望 ok/warn，实际 ${String(verdict)}`)
      const findings = asArray(j['findings'], 'findings').map((f) => asRecord(f, 'finding'))
      const missing = findings.filter((f) => f['code'] === 'MISSING_DEPENDENCY')
      if (missing.length > 0) {
        fail(
          `${String(missing.length)} 个依赖被判定缺失：` +
            missing.map((f) => String(f['subject'] ?? '?')).join(', '),
        )
      }
      const stats = asRecord(j['stats'], 'stats')
      assert(asNumber(stats['mods'], 'stats.mods') >= 48, 'stats.mods 期望 ≥ 48')
      assert(asNumber(stats['unresolved'], 'stats.unresolved') <= 1, 'unresolved 应该只有 mixintrace')
    },
  },
  {
    id: 'E2E-102',
    title: '未验证的依赖不能当成确定缺失',
    tier: 1,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'fo-6.5.0.mrpack'), '--no-host', '--json'], {
        timeoutMs: 180_000,
      })
      const j = parseJson(r, 'FO --json')
      assert(j['verdict'] !== 'blocked', 'FO 不该被判 blocked')
      const plan = asRecord(j['plan'], 'plan')
      const installs = asArray(plan['installs'], 'plan.installs').map((x) => asRecord(x, 'install'))
      // 字段契约：安装项必须是可直接下载的
      for (const item of installs) {
        for (const key of ['url', 'fileName', 'size', 'requiredBy', 'confidence']) {
          assert(item[key] !== undefined, `plan.installs.${key} 缺失`)
        }
      }
      const verified = installs.filter((i) => i['confidence'] !== 'unverified')
      if (verified.length > 0) {
        fail(
          `FO 的依赖都没有直接证据，却给出 ${String(verified.length)} 个确定安装项：` +
            verified.map((i) => String(i['fileName'] ?? '?')).join(', '),
        )
      }
      const findings = asArray(j['findings'], 'findings').map((x) => asRecord(x, 'finding'))
      assert(
        findings.every((f) => f['severity'] !== 'blocker'),
        'FO 不该出现 blocker 级 finding',
      )
    },
  },
  {
    id: 'E2E-103',
    title: '真实小包：无 blocker',
    tier: 1,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'real-pack.mrpack'), '--no-host', '--json'], {
        timeoutMs: 180_000,
      })
      const j = parseJson(r, 'real-pack --json')
      const verdict = j['verdict']
      assert(
        verdict === 'ok' || verdict === 'warn' || verdict === 'unknown',
        `verdict 异常：${String(verdict)}`,
      )
      const findings = asArray(j['findings'], 'findings').map((f) => asRecord(f, 'finding'))
      const blockers = findings.filter((f) => f['severity'] === 'blocker')
      assert(blockers.length === 0, `不应有 blocker：${blockers.map((b) => String(b['code'])).join(',')}`)
      const stats = asRecord(j['stats'], 'stats')
      assert(asNumber(stats['resolved'], 'stats.resolved') >= 2, 'resolved 期望 ≥ 2')
    },
  },
  {
    id: 'E2E-104',
    title: 'CurseForge 边界：能查但明确受限',
    tier: 1,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'cf-pack.zip'), '--no-host'], {
        timeoutMs: 120_000,
      })
      assertCode(r, 0, 'CF 包预检')
      assertText(r, 'CF_API_REQUIRED', 'CF 应明确说明需要 API key')
      assertNoText(r, 'BLOCKED', 'CF 包不应被硬判 blocked')
    },
  },
  {
    id: 'E2E-105',
    title: 'setup --dry-run：只算不装',
    tier: 1,
    async run(ctx) {
      const root = join(ctx.tmp, 'root-setup')
      const r = await ctx.cli(['setup', '1.21.1', '--root', root, '--dry-run'], {
        timeoutMs: 180_000,
      })
      assertCode(r, 0, 'setup --dry-run')
      assertText(r, '--dry-run', '应说明只算不装')
      const m = /(\d+)\s*个文件需要下载/.exec(strip(r.stdout))
      assert(m !== null, `没找到任务数${snippet(r)}`)
      const tasks = Number(m[1])
      assert(tasks > 20, `原版任务数应 > 20，实际 ${tasks}`)
      assert(!existsSync(join(root, 'libraries')), 'dry-run 不应创建 libraries/')
      assert(!existsSync(join(root, 'versions')), 'dry-run 不应创建 versions/')
    },
  },
  {
    id: 'E2E-106',
    title: 'install：未验证依赖默认不装，--include-unverified 才出计划',
    tier: 1,
    async run(ctx) {
      const modsDir = join(ctx.tmp, 'mods')
      // 故意不带 --no-host：这台机器没有 Java 时预检会判 BLOCKED，
      // install 仍必须退 0 —— 它只对「装」负责，「能不能跑」归 preflight / run
      const r = await ctx.cli(
        ['install', join(FIX, 'fo-6.5.0.mrpack'), '--mods-dir', modsDir, '--dry-run'],
        { timeoutMs: 180_000 },
      )
      assertCode(r, 0, 'install --dry-run')
      assertText(r, '没有需要自动补装的东西', '未验证依赖默认不装')
      assertText(r, '--include-unverified', '应告诉用户怎么装未验证项')
      assert(!existsSync(modsDir), '--dry-run 不应创建 mods 目录')

      const forced = await ctx.cli(
        ['install', join(FIX, 'fo-6.5.0.mrpack'), '--mods-dir', modsDir, '--dry-run', '--include-unverified'],
        { timeoutMs: 180_000 },
      )
      assertCode(forced, 0, 'install --include-unverified --dry-run')
      assertText(forced, '只打印计划', '应说明不下载')
      assertText(forced, '开始安装', '应列出安装项')
      assert(!existsSync(modsDir), '--dry-run 不应创建 mods 目录')
    },
  },
  {
    id: 'E2E-107',
    title: 'MCP preflight_modpack 契约',
    tier: 1,
    async run(ctx) {
      await withMcp(async (call) => {
        const res = await call('preflight_modpack', { path: join(FIX, 'demo.mrpack') })
        assert(res['isError'] !== true, 'preflight_modpack 不应 isError')
        const structured = asRecord(res['structuredContent'], 'structuredContent')
        const verdict = structured['verdict']
        assert(
          verdict === 'ok' || verdict === 'warn' || verdict === 'blocked' || verdict === 'unknown',
          `verdict 不合法：${String(verdict)}`,
        )
        assert(Array.isArray(structured['findings']), 'findings 应是数组')
      })
    },
  },
// ---------------- T2 真实下载 ----------------
  {
    id: 'E2E-201',
    title: '原版安装幂等：第二次全部跳过',
    tier: 2,
    async run(ctx) {
      const args = ['setup', '1.21.1', '--root', MCROOT, '--instance', 'fo']
      const first = await ctx.cli(args, { timeoutMs: 900_000 })
      assertCode(first, 0, 'setup 第一次')

      const second = await ctx.cli(args, { timeoutMs: 900_000 })
      assertCode(second, 0, 'setup 第二次')
      assertText(second, /下载 0 · 跳过 \d+ · 失败 0/, '第二次应全部跳过')

      const json = join(MCROOT, 'versions', '1.21.1', '1.21.1.json')
      assert(existsSync(json), '版本 JSON 没落盘，launch 会重新联网')
      const jar = join(MCROOT, 'versions', '1.21.1', '1.21.1.jar')
      assert(statSync(jar).size > 10 * 1024 * 1024, 'client jar 大小不对')

      const marker = readMarker(join(MCROOT, 'instances', 'fo'))
      assert(markerComponent(marker, 'net.minecraft') === '1.21.1', '标记里没有 MC 版本')
    },
  },
  {
    id: 'E2E-202',
    title: 'Fabric 加载器安装：标记与版本 JSON 落地',
    tier: 2,
    async run(ctx) {
      const r = await ctx.cli(
        [
          'fabric',
          '1.21.1',
          '--root',
          MCROOT,
          '--instance',
          'fo',
          '--loader',
          '0.19.3',
          '--china',
        ],
        { timeoutMs: 600_000 },
      )
      assertCode(r, 0, 'fabric --china')
      assertText(r, /失败 0/, '加载器库不应该失败')
      assert(
        existsSync(
          join(MCROOT, 'versions', 'fabric-loader-0.19.3-1.21.1', 'fabric-loader-0.19.3-1.21.1.json'),
        ),
        '加载器版本 JSON 没写',
      )
      const marker = readMarker(join(MCROOT, 'instances', 'fo'))
      assert(
        markerComponent(marker, 'net.fabricmc.fabric-loader') === '0.19.3',
        '标记里没有加载器版本',
      )
    },
  },

  // ---------------- T3 真实启动 ----------------
  {
    id: 'E2E-301',
    title: '真实启动：FO 实例进游戏后按时结束',
    tier: 3,
    async run(ctx) {
      const stop = process.env['BP_E2E_STOP'] ?? '60'
      const r = await ctx.cli(
        [
          'run',
          'fabric-loader-0.19.3-1.21.1',
          '--root',
          MCROOT,
          '--instance',
          'fo',
          '--stop',
          stop,
          '--quiet',
        ],
        { timeoutMs: 240_000 },
      )
      assertCode(r, 0, 'run --stop')
      // 到点结束，或者用户/游戏自己先正常退出，都算这次启动成功；
      // 真正的契约是「干净退出 + 确实进了游戏」，不是「必须跑满 N 秒」
      assertText(r, /已到时限结束|正常退出/, '应该是干净退出')
      assertNoText(r, '异常退出', '不该报成崩溃')

      const m = /日志\s+(\S+\.log)/.exec(strip(r.stdout))
      assert(m !== null, '没打印会话日志路径')
      const logPath = m[1]
      assert(logPath !== undefined && existsSync(logPath), `会话日志不存在：${String(logPath)}`)
      const content = readFileSync(logPath, 'utf8')
      assertMatch(content, /Loading Minecraft 1\.21\.1/, '日志里没有启动行')
      assertMatch(content, /Loading \d+ mods:/, '日志里没有模组加载行')
    },
  },
  {
    id: 'E2E-302',
    title: 'Java 路径错误：立刻失败，不去 spawn',
    tier: 3,
    async run(ctx) {
      const bad = join(ctx.tmp, 'nope', 'java.exe')
      const r = await ctx.cli(
        [
          'run',
          'fabric-loader-0.19.3-1.21.1',
          '--root',
          MCROOT,
          '--instance',
          'fo',
          '--java',
          bad,
        ],
        { timeoutMs: 60_000 },
      )
      assertCode(r, 1, '坏 java 路径')
      assertText(r, '指定的 Java 不存在', '应直接说路径不存在')
      assertNoText(r, '异常退出', '不该走到「启动后崩溃」')
    },
  },
  {
    id: 'E2E-303',
    title: '版本不兼容的模组：启动前就拦住',
    tier: 3,
    async run(ctx) {
      const target = join(MCROOT, 'instances', 'crash-check')
      rmSync(target, { recursive: true, force: true })
      try {
        cpSync(join(MCROOT, 'instances', 'fo'), target, { recursive: true })
        // 用 1.20.1 的 sodium 顶掉 1.21.1 的：真实世界里最常见的一类「装错版本」
        rmSync(join(target, 'mods', 'sodium-fabric-0.6.13+mc1.21.1.jar'), { force: true })
        cpSync(
          join(MCROOT, 'instances', 'good', 'mods', 'sodium-fabric-0.5.13+mc1.20.1.jar'),
          join(target, 'mods', 'sodium-fabric-0.5.13+mc1.20.1.jar'),
        )

        const r = await ctx.cli(['preflight', target, '--no-host'], { timeoutMs: 120_000 })
        assertCode(r, 2, '不兼容实例预检')
        assertText(r, 'BLOCKED', 'verdict')
        assertText(r, 'DEPENDENCY_VERSION_MISMATCH', '应报版本不匹配')
        assertText(r, /sodium .*1\.20\.1|minecraft.*1\.20\.1/, '应指出 sodium 要 1.20.1')
      } finally {
        rmSync(target, { recursive: true, force: true })
      }
    },
  },
// ---------------- T4 故障注入 ----------------
  {
    id: 'E2E-401',
    title: 'sha1 不符：拒绝落盘，不静默成功',
    tier: 4,
    async run(ctx) {
      const body = Buffer.from('this is definitely not the jar you asked for')
      const server = createServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        })
        res.end(body)
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
      const port = (server.address() as AddressInfo).port

      const instance = 'hash-check'
      const dir = join(MCROOT, 'instances', instance)
      try {
        const packPath = join(ctx.tmp, 'bad-hash.mrpack')
        writeFileSync(
          packPath,
          zipSync({
            'modrinth.index.json': strToU8(
              JSON.stringify({
                formatVersion: 1,
                game: 'minecraft',
                versionId: '1.0.0',
                name: 'Bad Hash Pack',
                dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.19.3' },
                files: [
                  {
                    path: 'mods/bad.jar',
                    hashes: { sha1: '0'.repeat(40), sha512: '0'.repeat(128) },
                    env: { client: 'required', server: 'required' },
                    downloads: [`http://127.0.0.1:${String(port)}/bad.jar`],
                    fileSize: body.length,
                  },
                ],
              }),
            ),
          }),
        )

        rmSync(dir, { recursive: true, force: true })
        const r = await ctx.cli(
          ['deploy', packPath, '--root', MCROOT, '--instance', instance, '--china'],
          { timeoutMs: 300_000 },
        )
        assertCode(r, 2, 'deploy 坏哈希')
        assertText(r, /hash mismatch/i, '应指出哈希不符')
        assertText(r, /失败 1/, '应计 1 个失败')
        assert(!existsSync(join(dir, 'mods', 'bad.jar')), '哈希不符的文件不该落盘')
      } finally {
        server.close()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  },
  {
    id: 'E2E-402',
    title: '断网：报网络错误并带地址，不说成「模组已下架」',
    tier: 4,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'fo-6.5.0.mrpack'), '--no-host'], {
        offline: true,
        timeoutMs: 60_000,
      })
      assertCode(r, 1, '断网预检')
      assertText(r, 'NETWORK_ERROR', '错误码')
      assertText(r, '无法访问 https://api.modrinth.com', '应带上失败的地址')
      assertNoText(r, '可能已下架', '网络故障不该说成模组下架')
      assert(r.ms < 30_000, `断网应快速失败，实际 ${String(r.ms)}ms`)
    },
  },
  {
    id: 'E2E-404',
    title: 'root 指向文件：立刻说清楚，不写半截目录',
    tier: 4,
    async run(ctx) {
      const file = join(ctx.tmp, 'not-a-dir')
      writeFileSync(file, 'x')
      const r = await ctx.cli(['setup', '1.21.1', '--root', file, '--dry-run'], {
        offline: true,
        timeoutMs: 30_000,
      })
      assertCode(r, 1, 'root 是文件')
      assertText(r, '不是文件夹', '应直接说 root 不可用')
      assertNoText(r, 'unexpected error', '不该是未处理异常')
      assert(existsSync(file), '不该动这个文件')
    },
  },
  {
    id: 'E2E-403',
    title: '代理不可用：同样快速失败',
    tier: 4,
    async run(ctx) {
      const r = await ctx.cli(
        ['preflight', join(FIX, 'fo-6.5.0.mrpack'), '--no-host', '--proxy', 'http://127.0.0.1:9'],
        { timeoutMs: 60_000 },
      )
      assertCode(r, 1, '坏代理')
      assertText(r, 'NETWORK_ERROR', '错误码')
    },
  },
]

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'KNOWN' | 'XPASS' | 'SKIP'

interface Outcome {
  readonly id: string
  readonly title: string
  readonly tier: number
  readonly status: Status
  readonly ms: number
  readonly message?: string
}

interface Options {
  tiers: number[]
  only: string[]
  list: boolean
  build: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { tiers: [0, 1], only: [], list: false, build: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--tier') {
      const v = argv[i + 1]
      if (v === undefined) fail('--tier 需要一个值，如 0,1')
      opts.tiers = v.split(',').map((s) => Number(s.trim()))
      i += 1
    } else if (a === '--only') {
      const v = argv[i + 1]
      if (v === undefined) fail('--only 需要一个用例 ID')
      opts.only = v.split(',').map((s) => s.trim())
      i += 1
    } else if (a === '--list') {
      opts.list = true
    } else if (a === '--no-build') {
      opts.build = false
    } else {
      fail(`未知参数：${a}`)
    }
  }
  return opts
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.list) {
    for (const c of CASES) {
      const tag = c.knownIssue === undefined ? '' : `  [known: ${c.knownIssue}]`
      process.stdout.write(`T${c.tier}  ${c.id}  ${c.title}${tag}\n`)
    }
    return 0
  }

  if (process.env['CI'] !== undefined && opts.tiers.some((t) => t > 1)) {
    process.stdout.write('CI 环境拒绝执行 T2+：会下载上百 MB 并可能开窗口。\n')
    opts.tiers = opts.tiers.filter((t) => t <= 1)
  }

  if (opts.tiers.some((t) => t >= 2)) {
    process.stdout.write('· T2+ 会写盘/联网；E2E-301 会打开一次游戏窗口\n')
  }

  const evidenceRoot = join(REPO, '.tmp-e2e', stamp())
  mkdirSync(evidenceRoot, { recursive: true })

  if (opts.build) {
    process.stdout.write('· 构建 dist … ')
    const r = await exec('npm', ['run', 'build'], { shell: true, timeoutMs: 180_000 })
    if (r.code !== 0) {
      process.stdout.write('失败\n')
      process.stdout.write(strip(r.stdout) + strip(r.stderr))
      return 1
    }
    process.stdout.write(`ok ${r.ms}ms\n`)
  }

  const selected = CASES.filter((c) => {
    if (!opts.tiers.includes(c.tier)) return false
    if (opts.only.length === 0) return true
    return opts.only.some((p) => c.id === p || c.id.startsWith(p))
  })

  if (selected.length === 0) {
    process.stdout.write('没有匹配的用例。用 --list 看有哪些。\n')
    return 1
  }

  const outcomes: Outcome[] = []

  for (const c of selected) {
    const missing = (REQUIRES[c.id] ?? []).filter((p) => !existsSync(p))
    if (missing.length > 0) {
      outcomes.push({
        id: c.id,
        title: c.title,
        tier: c.tier,
        status: 'SKIP',
        ms: 0,
        message: `缺夹具：${missing.join('、')}`,
      })
      continue
    }

    const ctx = new Ctx(c.id, evidenceRoot)
    const started = Date.now()
    try {
      await c.run(ctx)
      if (c.knownIssue !== undefined) {
        outcomes.push({
          id: c.id,
          title: c.title,
          tier: c.tier,
          status: 'XPASS',
          ms: Date.now() - started,
          message: `已知缺陷 ${c.knownIssue} 看起来已修好，删掉 knownIssue 标记`,
        })
      } else {
        outcomes.push({ id: c.id, title: c.title, tier: c.tier, status: 'PASS', ms: Date.now() - started })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (c.knownIssue !== undefined) {
        outcomes.push({
          id: c.id,
          title: c.title,
          tier: c.tier,
          status: 'KNOWN',
          ms: Date.now() - started,
          message: `${c.knownIssue}: ${message.split('\n')[0] ?? ''}`,
        })
      } else {
        outcomes.push({
          id: c.id,
          title: c.title,
          tier: c.tier,
          status: 'FAIL',
          ms: Date.now() - started,
          message,
        })
      }
    } finally {
      rmSync(ctx.tmp, { recursive: true, force: true })
    }
  }

  // ---- 输出 ----
  process.stdout.write('\n')
  for (const o of outcomes) {
    const mark =
      o.status === 'PASS'
        ? 'PASS '
        : o.status === 'FAIL'
          ? 'FAIL '
          : o.status === 'KNOWN'
            ? 'KNOWN'
            : o.status === 'SKIP'
              ? 'SKIP '
              : 'XPASS'
    const line = `${mark}  ${o.id}  ${o.title.padEnd(30, ' ')} ${String(o.ms).padStart(6, ' ')}ms`
    process.stdout.write(`${line}\n`)
    if (o.message !== undefined && o.status !== 'PASS') {
      for (const l of o.message.split('\n').slice(0, 14)) process.stdout.write(`        ${l}\n`)
    }
  }

  const count = (t: number, s: Status): number =>
    outcomes.filter((o) => o.tier === t && o.status === s).length
  const tiers = [...new Set(outcomes.map((o) => o.tier))].sort()

  process.stdout.write('\n')
  for (const t of tiers) {
    process.stdout.write(
      `T${t}  ${String(outcomes.filter((o) => o.tier === t).length)} 条：` +
        `PASS ${count(t, 'PASS')} · KNOWN ${count(t, 'KNOWN')} · FAIL ${count(t, 'FAIL')} · ` +
          `SKIP ${count(t, 'SKIP')} · XPASS ${count(t, 'XPASS')}\n`,
    )
  }

  const failed = outcomes.filter((o) => o.status === 'FAIL')
  const known = outcomes.filter((o) => o.status === 'KNOWN')
  const xpass = outcomes.filter((o) => o.status === 'XPASS')

  process.stdout.write(`\n证据：${evidenceRoot}\n`)

  const skipped = outcomes.filter((o) => o.status === 'SKIP')
  if (skipped.length > 0) {
    process.stdout.write(`跳过 ${skipped.length} 条：本机没有对应夹具（fixtures/ 被 gitignore）\n`)
  }
  if (known.length > 0) {
    process.stdout.write(
      `已知缺陷 ${known.length} 条（不算红）：${[...new Set(known.map((o) => o.message?.split(':')[0] ?? '?'))].join(', ')}\n`,
    )
  }
  if (xpass.length > 0) {
    process.stdout.write(`注意 ${xpass.length} 条 XPASS：缺陷可能已修，标记该删了\n`)
  }

  // ---- 报告 ----
  writeFileSync(
    join(evidenceRoot, 'report.json'),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        outcomes,
      },
      null,
      2,
    ),
    'utf8',
  )

  const lines: string[] = [
    '# BlockPilot 实测报告',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- 环境：${process.platform} / Node ${process.version}`,
    `- 用例：${String(outcomes.length)}（T${tiers.join(', T')}）`,
    '',
    '| 结果 | 用例 | 说明 | 耗时 |',
    '|---|---|---|---|',
  ]
  for (const o of outcomes) {
    const msg = (o.message ?? '').split('\n')[0]?.replace(/\|/g, '\\|') ?? ''
    lines.push(`| ${o.status} | ${o.id} ${o.title} | ${msg} | ${String(o.ms)}ms |`)
  }
  writeFileSync(join(evidenceRoot, 'report.md'), `${lines.join('\n')}\n`, 'utf8')

  return failed.length > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`执行器崩了：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  },
)
