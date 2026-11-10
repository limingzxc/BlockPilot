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
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { extractLogPath } from './lib/parse.js'

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
/** 贴吧真实帖子的 Fabric tinyremapper 堆空间崩溃，见 docs/testing/real-tests.md §3.1。 */
const OOM_LOG = join(TESTDATA, 'oom', 'logs', 'fabric-heap-space.log')

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 转义序列本来就有控制字符
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

/** `--events` 的 stdout 必须是纯 ndjson：任何一行解析失败都说明混进了人类文本。 */
function parseNdjson(r: RunResult, label: string): Record<string, unknown>[] {
  const lines = strip(r.stdout)
    .trim()
    .split('\n')
    .filter((l) => l !== '')
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new AssertError(`${label}：第 ${String(i + 1)} 行不是 JSON：${line.slice(0, 80)}`)
    }
  })
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

/**
 * 造一个最小 Fabric 模组 jar。
 *
 * T0 不依赖 `fixtures/`：真实用户 mods/ 里的 jar 也是这个结构，zipSync 现造
 * 足够让本地扫描读到 modId、版本与依赖。CI 上没有 1.7 GB 夹具也能跑。
 */
function fakeFabricMod(
  modId: string,
  opts: { version?: string; depends?: Record<string, string> } = {},
): Uint8Array {
  const meta: Record<string, unknown> = {
    schemaVersion: 1,
    id: modId,
    version: opts.version ?? '1.0.0',
    name: modId,
  }
  if (opts.depends !== undefined) meta.depends = opts.depends
  return zipSync({ 'fabric.mod.json': strToU8(JSON.stringify(meta)) })
}

/** 写一个 Prism/MultiMC 实例标记，让本地预检能拿到 MC 版本与加载器。 */
function writeInstanceMarker(
  dir: string,
  gameVersion: string,
  loader: 'fabric' | 'forge',
  loaderVersion: string,
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'mmc-pack.json'),
    JSON.stringify({
      components: [
        { uid: 'net.minecraft', version: gameVersion },
        {
          uid: loader === 'fabric' ? 'net.fabricmc.fabric-loader' : 'net.minecraftforge',
          version: loaderVersion,
        },
      ],
    }),
  )
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
  'E2E-028': [FO_CRASH_LOG],
  'E2E-029': [FO_CRASH_LOG],
  'E2E-035': [OOM_LOG],
  'E2E-101': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-102': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-103': [join(FIX, 'real-pack.mrpack')],
  'E2E-104': [join(FIX, 'cf-pack.zip')],
  'E2E-106': [join(FIX, 'fo-6.5.0.mrpack')],
  'E2E-107': [join(FIX, 'demo.mrpack')],
  'E2E-108': [MCROOT],
  'E2E-110': [MCROOT],
  'E2E-201': [MCROOT],
  'E2E-202': [MCROOT],
  'E2E-204': [join(FIX, 'closure.mrpack')],
  'E2E-205': [MCROOT],
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

async function withMcp(
  fn: (
    call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    tools: string[],
  ) => Promise<void>,
): Promise<void> {
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
    const call = async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, unknown>> => {
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
      const r = await ctx.cli(['preflight', join(FIX, 'instance-miss'), '--no-host', '--json'], {
        offline: true,
      })
      assertCode(r, 2, 'instance-miss --json')
      const j = parseJson(r, '--json')

      assert(j.verdict === 'blocked', `verdict 期望 blocked，实际 ${String(j.verdict)}`)
      const findings = asArray(j.findings, 'findings')
      assert(findings.length > 0, 'findings 不应为空')
      for (const f of findings) {
        const item = asRecord(f, 'finding')
        for (const key of ['severity', 'code', 'message']) {
          assert(typeof item[key] === 'string', `finding.${key} 应为 string`)
        }
      }

      const stats = asRecord(j.stats, 'stats')
      assert(asNumber(stats.mods, 'stats.mods') === 2, 'stats.mods 期望 2')
      assert(asNumber(stats.resolved, 'stats.resolved') === 1, 'stats.resolved 期望 1')

      const plan = asRecord(j.plan, 'plan')
      assert(asArray(plan.installs, 'plan.installs').length === 0, '离线计划应为空')
      asArray(plan.manual, 'plan.manual')

      const at = j.generatedAt
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
      const findings = asArray(j.findings, 'findings').map((f) => asRecord(f, 'finding'))
      const unreadable = findings.filter((f) => f.code === 'UNREADABLE_JAR')
      if (unreadable.length > 0) {
        fail(
          `有 ${String(unreadable.length)} 条 UNREADABLE_JAR：` +
            `${String(unreadable[0]?.message ?? '')} / ${String(unreadable[0]?.hint ?? '')}`,
        )
      }
      const stats = asRecord(j.stats, 'stats')
      assert(asNumber(stats.mods, 'stats.mods') === 48, 'stats.mods 期望 48')
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
    async run(_ctx) {
      await withMcp(async (call, tools) => {
        assert(
          tools.join(',') === 'diagnose_crash,preflight_modpack',
          `工具清单期望 [diagnose_crash, preflight_modpack]，实际 [${tools.join(', ')}]`,
        )
        const res = await call('diagnose_crash', { logPath: FO_CRASH_LOG })
        assert(res.isError !== true, 'diagnose_crash 不应 isError')
        const structured = asRecord(res.structuredContent, 'structuredContent')
        assert(
          structured.verdict === 'crash',
          `verdict 期望 crash，实际 ${String(structured.verdict)}`,
        )
        const culprits = asArray(structured.culprits, 'culprits')
        assert(culprits.length > 0, 'culprits 不应为空')
        const first = asRecord(culprits[0], 'culprit')
        assert(first.modId === 'controlify', `第一嫌疑期望 controlify，实际 ${String(first.modId)}`)
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
        [
          'launch',
          'fabric-loader-0.19.3-1.21.1',
          '--root',
          MCROOT,
          '--instance',
          'fo',
          '--memory',
          '4096',
        ],
        { timeoutMs: 60_000 },
      )
      assertCode(ok, 0, '--memory 4096')
      assertText(ok, '-Xmx4096M', '内存参数')
    },
  },

  {
    id: 'E2E-015',
    title: 'verify：按 lock.json 核对缺失与哈希',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'verify-root')
      const instance = 'v1'
      const gameDir = join(root, 'instances', instance)
      mkdirSync(join(gameDir, 'mods'), { recursive: true })
      mkdirSync(join(gameDir, '.blockpilot'), { recursive: true })

      const body = Buffer.from('hello verify')
      writeFileSync(join(gameDir, 'mods', 'a.jar'), body)
      const sha1 = createHash('sha1').update(body).digest('hex')
      writeFileSync(
        join(gameDir, '.blockpilot', 'lock.json'),
        JSON.stringify({
          version: 1,
          pack: { name: 't', kind: 'mrpack', file: 'p.mrpack' },
          target: { gameVersion: '1.20.1', loader: { kind: 'fabric', version: '0.16.14' } },
          complete: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
          files: [{ path: 'mods/a.jar', sha1, size: body.length }],
        }),
      )

      const ok = await ctx.cli(['verify', '--root', root, '--instance', instance])
      assertCode(ok, 0, 'verify 正常')
      assertText(ok, /全部文件与清单一致/, 'verify 结论')

      writeFileSync(join(gameDir, 'mods', 'a.jar'), 'tampered')
      const bad = await ctx.cli(['verify', '--root', root, '--instance', instance, '--json'])
      assertCode(bad, 2, 'verify 哈希不符')
      const j = parseJson(bad, 'verify --json')
      const issues = asArray(j.issues, 'issues')
      assert(issues.length === 1, `期望 1 条问题，实际 ${String(issues.length)}`)
      assert(asRecord(issues[0], 'issue').reason === 'mismatch', 'reason 应为 mismatch')
    },
  },

  {
    id: 'E2E-016',
    title: 'diag 发现 hs_err：不能判成 clean',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'hs-root')
      const instance = 'hs'
      const gameDir = join(root, 'instances', instance)
      mkdirSync(join(gameDir, 'logs'), { recursive: true })
      writeFileSync(
        join(gameDir, 'hs_err_pid123.log'),
        [
          '# A fatal error has been detected by the Java Runtime Environment:',
          '#',
          '#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x1234, pid=123, tid=456',
          '#',
          '# JRE version: OpenJDK Runtime Environment (17.0.8+7)',
          '# Problematic frame:',
          '# C  [lwjgl.dll+0x1a2b]',
          '#',
          'Java frames: (J=compiled Java code, j=interpreted, Vv=VM code)',
          'j  org.lwjgl.system.JNI.invokePV(JJ)V+8',
          'j  com.example.render.Renderer.render()V+42',
          '',
        ].join('\n'),
      )

      const r = await ctx.cli(['diag', '--root', root, '--instance', instance, '--json'], {
        timeoutMs: 60_000,
      })
      assertCode(r, 2, 'hs_err 应判 crash')
      const j = parseJson(r, 'diag --json')
      assert(j.format === 'hs-err', `format 期望 hs-err，实际 ${String(j.format)}`)
      assert(j.verdict === 'crash', `verdict 期望 crash，实际 ${String(j.verdict)}`)
      const primary = asRecord(j.primary, 'primary')
      assert(primary.kind === 'graphics', `kind 期望 graphics，实际 ${String(primary.kind)}`)
    },
  },

  {
    id: 'E2E-017',
    title: 'config：写入、读取、删除实例配置',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'config-root')
      const instance = 'c1'
      const base = ['config', '--root', root, '--instance', instance]

      const set = await ctx.cli([
        ...base,
        '--memory',
        '4096',
        '--java',
        '/opt/java/bin/java',
        '--jvm-args',
        '-XX:+UseG1GC -XX:+AlwaysPreTouch',
      ])
      assertCode(set, 0, 'config 写入')

      const read = await ctx.cli([...base, '--json'])
      assertCode(read, 0, 'config 读取')
      const j = parseJson(read, 'config --json')
      const config = asRecord(j.config, 'config')
      assert(config.memoryMiB === 4096, `memoryMiB=${String(config.memoryMiB)}`)
      assert(config.javaPath === '/opt/java/bin/java', 'javaPath')
      assert(asArray(config.jvmArgs, 'jvmArgs').length === 2, 'jvmArgs')

      const unset = await ctx.cli([...base, '--unset', 'memory', '--json'])
      assertCode(unset, 0, 'config 删除')
      const after = asRecord(parseJson(unset, 'config --unset --json').config, 'config')
      assert(after.memoryMiB === undefined, 'memory 应被删除')
      assert(after.javaPath === '/opt/java/bin/java', 'java 应保留')

      const bad = await ctx.cli([...base, '--memory', 'abc'])
      assertCode(bad, 1, '非法内存')
      assertText(bad, 'BAD_MEMORY', '稳定错误码')
    },
  },

  {
    id: 'E2E-018',
    title: 'accounts：过滤坏条目、当前账号、按名字移除',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'accounts-root')
      const store = join(root, 'auth', 'accounts.json')
      const uuid = 'a'.repeat(32)

      const empty = await ctx.cli(['accounts', '--root', root], { offline: true })
      assertCode(empty, 0, '空存档')
      assertText(empty, '还没有账号', '空存档提示')

      // 一条形状完整、一条 uuid 不合法：坏条目必须在读存档时就被过滤，
      // 而不是留到 run 启动时才炸（store 的 isValidAccount 契约）
      mkdirSync(join(root, 'auth'), { recursive: true })
      writeFileSync(
        store,
        JSON.stringify({
          version: 1,
          active: uuid,
          accounts: [
            {
              uuid,
              name: 'Alex',
              accessToken: 'tok',
              expiresAt: Date.now() + 3_600_000,
              obtainedAt: Date.now(),
            },
            { uuid: 'broken', name: 'Broken', accessToken: 'x', expiresAt: 0, obtainedAt: 0 },
          ],
        }),
      )

      const listed = await ctx.cli(['accounts', '--root', root], { offline: true })
      assertCode(listed, 0, '列出账号')
      assertText(listed, 'Alex', '有效账号应显示')
      assertText(listed, uuid, 'uuid 应显示')
      assertText(listed, /[*]\s+Alex/, '当前账号应有标记')
      assertNoText(listed, 'Broken', '形状不完整的条目应被过滤')

      // 名字大小写不敏感：玩家记得的是「Alex」，不会照着 uuid 敲
      const removed = await ctx.cli(['accounts', '--root', root, '--remove', 'alex'], {
        offline: true,
      })
      assertCode(removed, 0, '按名字删除')
      const after = await ctx.cli(['accounts', '--root', root], { offline: true })
      assertText(after, '还没有账号', '删完后应为空')

      const ghost = await ctx.cli(['accounts', '--root', root, '--remove', 'Ghost'], {
        offline: true,
      })
      assertCode(ghost, 1, '删除不存在的账号')
      assertText(ghost, '没有这个账号', '应说明没找到')
    },
  },

  {
    id: 'E2E-020',
    title: 'config --jvm-args 真正进入启动命令',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'jvmargs-root')
      const instance = 'jvm'
      // 只需要一个能在本地解析的版本 JSON；不需要真的下载 client jar
      mkdirSync(join(root, 'versions', '1.20.1'), { recursive: true })
      writeFileSync(
        join(root, 'versions', '1.20.1', '1.20.1.json'),
        JSON.stringify({
          id: '1.20.1',
          type: 'release',
          mainClass: 'net.minecraft.client.main.Main',
          assets: '5',
          libraries: [],
          arguments: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            jvm: ['-cp', '${classpath}'],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            game: ['--username', '${auth_player_name}'],
          },
        }),
      )

      const set = await ctx.cli([
        'config',
        '--root',
        root,
        '--instance',
        instance,
        '--jvm-args',
        '--add-opens java.base/java.lang=ALL-UNNAMED',
      ])
      assertCode(set, 0, 'config 写入 jvmArgs')

      const launch = await ctx.cli([
        'launch',
        '1.20.1',
        '--root',
        root,
        '--instance',
        instance,
        // 显式路径只检查存在性，不探测；用本进程的 node 当占位 java
        '--java',
        process.execPath,
        '--memory',
        '2048',
      ])
      assertCode(launch, 0, 'launch 生成命令')
      assertText(launch, '--add-opens', 'jvmArgs 应进入命令')
      assertText(launch, 'java.base/java.lang=ALL-UNNAMED', 'jvmArgs 的值应完整保留')
      assertText(launch, '-Xmx2048M', '内存参数应同时存在')
    },
  },

  {
    id: 'E2E-021',
    title: 'install --events：stdout 只有 JSON，且只写一个 exit',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'install-events-root')
      const instance = 'e1'
      const gameDir = join(root, 'instances', instance)
      mkdirSync(join(gameDir, 'mods'), { recursive: true })

      const r = await ctx.cli([
        'install',
        gameDir,
        '--mods-dir',
        join(gameDir, 'mods'),
        '--no-host',
        '--events',
      ])
      assertCode(r, 0, '没有要补的依赖应成功')

      const lines = r.stdout
        .trim()
        .split('\n')
        .filter((l) => l !== '')
      const events = lines.map((l, i) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          throw new Error(`第 ${String(i + 1)} 行不是 JSON：${l.slice(0, 80)}`)
        }
      })
      assert(!r.stdout.includes('\u001b['), 'stdout 不应有 ANSI 颜色')
      const exits = events.filter((e) => e.type === 'exit')
      assert(exits.length === 1, `exit 行应只有一个，实际 ${String(exits.length)}`)
      assert(exits[0]?.code === 0, `exit.code 期望 0，实际 ${String(exits[0]?.code)}`)
      assert(events[events.length - 1]?.type === 'exit', '最后一行应是 exit')
    },
  },

  {
    id: 'E2E-022',
    title: '--stop 非法值给稳定码，不把 NaN 丢给 setTimeout',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli([
        'run',
        '1.20.1',
        '--root',
        join(ctx.tmp, 'stop-root'),
        '--instance',
        's1',
        '--stop',
        'abc',
      ])
      assertCode(r, 1, '非法 --stop')
      assertText(r, 'BAD_STOP', '稳定错误码')
    },
  },

  {
    id: 'E2E-023',
    title: '--events 不泄漏在线账号令牌',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'events-token-root')
      const instance = 'tok'
      const uuid = '0'.repeat(32)
      const secret = 'secret-token-123'
      mkdirSync(join(root, 'versions', '1.20.1'), { recursive: true })
      writeFileSync(
        join(root, 'versions', '1.20.1', '1.20.1.json'),
        JSON.stringify({
          id: '1.20.1',
          type: 'release',
          mainClass: 'net.minecraft.client.main.Main',
          assets: '5',
          libraries: [],
          arguments: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            jvm: ['-cp', '${classpath}'],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}'],
          },
        }),
      )
      mkdirSync(join(root, 'auth'), { recursive: true })
      writeFileSync(
        join(root, 'auth', 'accounts.json'),
        JSON.stringify({
          version: 1,
          active: uuid,
          accounts: [
            {
              uuid,
              name: 'Tester',
              accessToken: secret,
              expiresAt: Date.now() + 3_600_000,
              obtainedAt: Date.now(),
            },
          ],
        }),
      )

      const r = await ctx.cli([
        'launch',
        '1.20.1',
        '--root',
        root,
        '--instance',
        instance,
        '--java',
        process.execPath,
        '--account',
        'Tester',
        '--events',
      ])
      assertCode(r, 0, 'launch --events')
      assert(!r.stdout.includes(secret), 'stdout 不应出现真实 accessToken')

      const events = r.stdout
        .trim()
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      const result = events.find((e) => e.type === 'result')
      assert(result !== undefined, '应包含 result 事件')
      const value = asRecord(result.value, 'result.value')
      const args = asArray(value.args, 'result.value.args')
      const at = args.indexOf('--accessToken')
      assert(at >= 0, 'args 里应保留 --accessToken 占位')
      assert(args[at + 1] === '***', `--accessToken 的值应脱敏，实际 ${String(args[at + 1])}`)
      assert(events[events.length - 1]?.type === 'exit', '最后一行应是 exit')
    },
  },

  {
    id: 'E2E-024',
    title: 'java：install 参数校验与托管目录发现',
    tier: 0,
    async run(ctx) {
      // 三个都在任何网络请求之前失败：缺大版本、非数字、低于 8
      for (const args of [
        ['java', 'install'],
        ['java', 'install', 'abc'],
        ['java', 'install', '7'],
      ]) {
        const r = await ctx.cli(args, { offline: true, timeoutMs: 30_000 })
        assertCode(r, 1, args.join(' '))
      }

      // 托管 JRE 的发现是真实文件系统行为（<root>/java/<name>/bin/java），
      // 单测只能造假目录；有夹具时用真 JRE 稳一下
      if (!existsSync(join(MCROOT, 'java'))) return
      const scan = await ctx.cli(['java', '--root', MCROOT], { offline: true, timeoutMs: 90_000 })
      assertCode(scan, 0, 'java 扫描')
      assertText(scan, 'Java 21', '应识别托管 JRE 21')
      assertText(scan, join(MCROOT, 'java'), '应列出 <root>/java 下的路径')
    },
  },

  {
    id: 'E2E-025',
    title: '空格与中文路径：config → launch → verify 全链路',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, '我的 世界', '根 目录')
      const instance = '实例 a'
      const gameDir = join(root, 'instances', instance)
      const version = '1.20.1'
      mkdirSync(join(root, 'versions', version), { recursive: true })
      writeFileSync(
        join(root, 'versions', version, `${version}.json`),
        JSON.stringify({
          id: version,
          type: 'release',
          mainClass: 'net.minecraft.client.main.Main',
          assets: '5',
          libraries: [],
          arguments: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            jvm: ['-cp', '${classpath}'],
            // biome-ignore lint/suspicious/noTemplateCurlyInString: 版本 JSON 的占位符
            game: ['--username', '${auth_player_name}'],
          },
        }),
      )

      const set = await ctx.cli(
        [
          'config',
          '--root',
          root,
          '--instance',
          instance,
          '--java',
          process.execPath,
          '--memory',
          '3072',
          '--jvm-args',
          '-XX:+UseG1GC',
        ],
        { offline: true },
      )
      assertCode(set, 0, 'config 写入')

      const read = await ctx.cli(['config', '--root', root, '--instance', instance, '--json'], {
        offline: true,
      })
      const config = asRecord(parseJson(read, 'config --json').config, 'config')
      assert(config.javaPath === process.execPath, 'javaPath 应原样保留含空格的路径')

      const launch = await ctx.cli(
        ['launch', version, '--root', root, '--instance', instance, '--raw', '--offline'],
        { offline: true },
      )
      assertCode(launch, 0, 'launch')
      assertText(launch, process.execPath, '配置里的 java 应进入启动命令')
      assertText(launch, '-Xmx3072M', '内存参数')
      assertText(launch, '-XX:+UseG1GC', 'jvmArgs')

      const body = Buffer.from('中文路径 mod')
      const settings = Buffer.from('{"lang":"zh_cn"}')
      mkdirSync(join(gameDir, 'mods'), { recursive: true })
      mkdirSync(join(gameDir, 'config'), { recursive: true })
      mkdirSync(join(gameDir, '.blockpilot'), { recursive: true })
      writeFileSync(join(gameDir, 'mods', '中 文.jar'), body)
      writeFileSync(join(gameDir, 'config', '设置 文件.json'), settings)
      writeFileSync(
        join(gameDir, '.blockpilot', 'lock.json'),
        JSON.stringify({
          version: 1,
          pack: { name: '中文包', kind: 'mrpack', file: 'p.mrpack' },
          target: { gameVersion: version, loader: { kind: 'vanilla', version } },
          complete: true,
          updatedAt: '2026-01-01T00:00:00.000Z',
          files: [
            {
              path: 'mods/中 文.jar',
              sha1: createHash('sha1').update(body).digest('hex'),
              size: body.length,
            },
            {
              path: 'config/设置 文件.json',
              sha512: createHash('sha512').update(settings).digest('hex'),
              size: settings.length,
            },
          ],
        }),
      )

      const verify = await ctx.cli(['verify', '--root', root, '--instance', instance, '--json'], {
        offline: true,
      })
      assertCode(verify, 0, 'verify 中文路径')
      const report = parseJson(verify, 'verify --json')
      assert(report.okAll === true, '所有文件与清单应一致')
      assert(asNumber(report.checked, 'checked') === 2, 'checked 期望 2')
    },
  },

  {
    id: 'E2E-026',
    title: '坏 lock / 坏配置：稳定错误码，不崩成 unexpected error',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'broken-root')
      const instance = 'b1'
      const gameDir = join(root, 'instances', instance)
      mkdirSync(join(gameDir, '.blockpilot'), { recursive: true })
      const lockFile = join(gameDir, '.blockpilot', 'lock.json')

      const noLock = await ctx.cli(['verify', '--root', root, '--instance', instance], {
        offline: true,
      })
      assertCode(noLock, 1, '没有 lock 的 verify')
      assertText(noLock, 'LOCK_NOT_FOUND', '稳定错误码')

      const noLockUpdate = await ctx.cli(['update', '--root', root, '--instance', instance], {
        offline: true,
      })
      assertCode(noLockUpdate, 1, '没有 lock 的 update')
      assertText(noLockUpdate, 'LOCK_NOT_FOUND', '稳定错误码')

      const noLockLoader = await ctx.cli(
        ['update', '--root', root, '--instance', instance, '--loader'],
        { offline: true },
      )
      assertCode(noLockLoader, 1, '没有 lock 的 --loader')
      assertText(noLockLoader, 'lock.json', '应说明缺的是 lock.json')

      writeFileSync(lockFile, '{')
      const corrupt = await ctx.cli(['verify', '--root', root, '--instance', instance], {
        offline: true,
      })
      assertCode(corrupt, 1, '坏 JSON 的 verify')
      assertText(corrupt, 'LOCK_CORRUPT', '稳定错误码')
      assertNoText(corrupt, 'unexpected error', '不该是未处理异常')

      writeFileSync(lockFile, JSON.stringify({ version: 2, files: [], pack: {}, target: {} }))
      const version2 = await ctx.cli(['update', '--root', root, '--instance', instance], {
        offline: true,
      })
      assertCode(version2, 1, '版本不认识的 lock')
      assertText(version2, 'LOCK_CORRUPT', '稳定错误码')

      writeFileSync(
        lockFile,
        JSON.stringify({
          version: 1,
          pack: { name: '半成品', kind: 'mrpack', file: 'p.mrpack' },
          target: { gameVersion: '1.21.1', loader: { kind: 'fabric', version: '0.19.3' } },
          complete: false,
          updatedAt: '2026-01-01T00:00:00.000Z',
          files: [],
        }),
      )
      const incomplete = await ctx.cli(
        ['verify', '--root', root, '--instance', instance, '--json'],
        { offline: true },
      )
      assertCode(incomplete, 2, '未完成的部署')
      const report = parseJson(incomplete, 'incomplete verify')
      assert(report.okAll === false, 'okAll 应为 false')
      assert(asArray(report.issues, 'issues').length === 0, '文件都在时 issues 应为空')

      writeFileSync(join(gameDir, '.blockpilot', 'config.json'), '{"version":99}')
      const badConfig = await ctx.cli(
        ['config', '--root', root, '--instance', instance, '--json'],
        { offline: true },
      )
      assertCode(badConfig, 1, '坏配置')
      assertText(badConfig, 'CONFIG_CORRUPT', '稳定错误码')
    },
  },

  {
    id: 'E2E-027',
    title: '--events 失败路径：stdout 仍只有 ndjson，且只有一个 exit',
    tier: 0,
    async run(ctx) {
      const missing = await ctx.cli(['preflight', join(ctx.tmp, 'nope'), '--no-host', '--events'], {
        offline: true,
      })
      assertCode(missing, 1, '不存在的 target')
      assertNoText(missing, '\u001b[', '事件流不应有 ANSI')
      const events = parseNdjson(missing, 'preflight --events')
      assert(events.length >= 2, `事件太少：${String(events.length)}`)
      assert(
        events.some((e) => e.type === 'failed' && e.code === 'TARGET_NOT_FOUND'),
        '应有 TARGET_NOT_FOUND',
      )
      const exits = events.filter((e) => e.type === 'exit')
      assert(exits.length === 1 && exits[0]?.code === 1, '应有且只有一个 exit=1')
      assert(events[events.length - 1]?.type === 'exit', '最后一行应是 exit')

      // 未知命令走 main 的入口分支，不经过 Operation；漏了 emitExit 时消费者
      // 只能等到管道关闭才知道结束
      const unknown = await ctx.cli(['nosuchcommand', '--events'], { offline: true })
      assertCode(unknown, 1, '未知命令')
      const unknownEvents = parseNdjson(unknown, '未知命令 --events')
      assert(
        unknownEvents.some((e) => e.type === 'failed' && e.code === 'UNKNOWN_COMMAND'),
        '应有 UNKNOWN_COMMAND',
      )
      assert(unknownEvents.filter((e) => e.type === 'exit').length === 1, 'exit 不应重复')

      // 代理在命令分发前解析；失败时同样要以 exit 收尾
      const badProxy = await ctx.cli(
        ['preflight', join(FIX, 'instance-ok'), '--proxy', 'socks5://127.0.0.1:1080', '--events'],
        { offline: true },
      )
      assertCode(badProxy, 1, '不支持的代理协议')
      const proxyEvents = parseNdjson(badProxy, '坏代理 --events')
      assert(
        proxyEvents.length === 1 && proxyEvents[0]?.type === 'exit' && proxyEvents[0]?.code === 1,
        'stdout 只应有 exit=1',
      )
    },
  },

  {
    id: 'E2E-028',
    title: 'diag 自动选证据：logs 混放时按 mtime 挑最新',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'diag-root')
      const instance = 'd1'
      const gameDir = join(root, 'instances', instance)
      mkdirSync(join(gameDir, 'logs'), { recursive: true })
      const old = join(gameDir, 'logs', '2026-01-01-1.log')
      writeFileSync(old, 'clean log\n')
      const latest = join(gameDir, 'logs', 'latest.log')
      cpSync(FO_CRASH_LOG, latest)
      // Windows 的 CopyFile 会保留源文件时间戳；这里显式设成「一小时前 vs 现在」，
      // 否则结果取决于样本自己有多旧
      const past = new Date(Date.now() - 3_600_000)
      utimesSync(old, past, past)
      const now = new Date()
      utimesSync(latest, now, now)

      const r = await ctx.cli(['diag', '--root', root, '--instance', instance, '--json'], {
        offline: true,
        timeoutMs: 60_000,
      })
      assertCode(r, 2, '自动发现的崩溃日志')
      const j = parseJson(r, 'diag --json')
      assert(j.verdict === 'crash', `verdict 期望 crash，实际 ${String(j.verdict)}`)
      assert(
        String(j.logPath).endsWith('latest.log'),
        `应挑最新的 latest.log，实际 ${String(j.logPath)}`,
      )
      const primary = asRecord(j.primary, 'primary')
      assert(primary.kind === 'mixin', `kind 期望 mixin，实际 ${String(primary.kind)}`)
    },
  },

  {
    id: 'E2E-029',
    title: 'MCP 错误输入：返回 isError，服务仍继续响应',
    tier: 0,
    async run(ctx) {
      await withMcp(async (call) => {
        const notLog = await call('diagnose_crash', { logPath: join(FIX, 'fo-6.5.0.mrpack') })
        assert(notLog.isError === true, '非 .log/.txt 应 isError')

        const missingLog = await call('diagnose_crash', { logPath: join(ctx.tmp, 'nope.log') })
        assert(missingLog.isError === true, '不存在的日志应 isError')

        const missingPack = await call('preflight_modpack', {
          path: join(ctx.tmp, 'nope.mrpack'),
        })
        assert(missingPack.isError === true, '不存在的包应 isError')

        // 连续三次坏输入后仍能正常返回：stdio server 不能因为一次坏参数就死掉
        const ok = await call('diagnose_crash', { logPath: FO_CRASH_LOG })
        assert(ok.isError !== true, '真实日志应成功')
        const structured = asRecord(ok.structuredContent, 'structuredContent')
        assert(
          structured.verdict === 'crash',
          `verdict 期望 crash，实际 ${String(structured.verdict)}`,
        )
      })
    },
  },

  {
    id: 'E2E-030',
    title: '同一个模组下了两份：必须判 BLOCKED',
    tier: 0,
    async run(ctx) {
      const dir = join(ctx.tmp, 'dup', 'instances', 'dup')
      writeInstanceMarker(dir, '1.21.1', 'fabric', '0.19.3')
      mkdirSync(join(dir, 'mods'), { recursive: true })
      writeFileSync(
        join(dir, 'mods', 'sodium-0.5.13.jar'),
        fakeFabricMod('sodium', { version: '0.5.13' }),
      )
      writeFileSync(
        join(dir, 'mods', 'sodium-0.6.13.jar'),
        fakeFabricMod('sodium', { version: '0.6.13' }),
      )

      const r = await ctx.cli(['preflight', dir, '--no-host'], { offline: true })
      assertCode(r, 2, '重复模组')
      assertText(r, 'BLOCKED', 'verdict')
      assertText(r, 'DUPLICATE_MOD', 'finding code')
      assertText(r, 'sodium-0.5.13.jar', '应列出第一份')
      assertText(r, 'sodium-0.6.13.jar', '应列出第二份')
    },
  },

  {
    id: 'E2E-031',
    title: '下载中断留下半个 jar：报损坏，不误报缺前置',
    tier: 0,
    async run(ctx) {
      const dir = join(ctx.tmp, 'half', 'instances', 'half')
      writeInstanceMarker(dir, '1.21.1', 'fabric', '0.19.3')
      mkdirSync(join(dir, 'mods'), { recursive: true })
      // 合法 zip 被截断，模拟下载中断/杀软拦截后留下的文件
      writeFileSync(join(dir, 'mods', 'lithium-0.1.jar'), fakeFabricMod('lithium').slice(0, 40))

      const r = await ctx.cli(['preflight', dir, '--no-host'], { offline: true })
      assertCode(r, 0, '损坏 jar 只是 warning')
      assertText(r, 'CORRUPT_JAR', 'finding code')
      assertText(r, /删掉重下|损坏/, '应给出可执行建议')
      assertNoText(r, 'MISSING_DEPENDENCY', '坏 jar 不该被说成缺前置')
      assertNoText(r, 'BLOCKED', '单个坏 jar 不该判 blocked')
    },
  },

  {
    id: 'E2E-032',
    title: 'Fabric 模组误装进 Forge 实例：只提示跳过，不判缺依赖',
    tier: 0,
    async run(ctx) {
      const dir = join(ctx.tmp, 'wrong-loader', 'instances', 'forge')
      writeInstanceMarker(dir, '1.20.1', 'forge', '47.2.0')
      mkdirSync(join(dir, 'mods'), { recursive: true })
      writeFileSync(
        join(dir, 'mods', 'iris-1.7.6.jar'),
        fakeFabricMod('iris', { depends: { 'fabric-api': '*' } }),
      )

      const r = await ctx.cli(['preflight', dir, '--no-host'], { offline: true })
      assertCode(r, 0, '加载器不匹配只是 warning')
      assertText(r, 'LOADER_MISMATCH', 'finding code')
      assertText(r, /跳过|不会加载/, '应说明 jar 会被跳过')
      assertNoText(r, 'MISSING_DEPENDENCY', '被跳过的 jar 的依赖不该参与检查')
      assertNoText(r, 'BLOCKED', '加载器不匹配不该判 blocked')
    },
  },

  {
    id: 'E2E-033',
    title: '1.19+ 缺 assets：预检拦住，别等崩在标题画面',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'no-assets')
      const dir = join(root, 'instances', 'a')
      writeInstanceMarker(dir, '1.20.1', 'fabric', '0.15.11')
      mkdirSync(join(dir, 'mods'), { recursive: true })
      writeFileSync(join(dir, 'mods', 'sodium.jar'), fakeFabricMod('sodium'))
      mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })
      writeFileSync(
        join(root, 'assets', 'indexes', '5.json'),
        JSON.stringify({
          objects: { 'minecraft/lang/zh_cn.json': { hash: 'a'.repeat(40), size: 1 } },
        }),
      )

      const r = await ctx.cli(['preflight', dir, '--no-host'], { offline: true })
      assertCode(r, 2, '缺 assets')
      assertText(r, 'BLOCKED', 'verdict')
      assertText(r, 'ASSETS_MISSING', 'finding code')
      assertText(r, 'blockpilot assets 1.20.1', '提示里应给对版本')
      assertNoText(r, 'blockpilot assets 5', '不能把 index id 当 MC 版本')
    },
  },

  {
    id: 'E2E-034',
    title: '版本隔离：diag 只看当前实例，不读别的实例日志',
    tier: 0,
    async run(ctx) {
      const root = join(ctx.tmp, 'diag-isolation')
      const a = join(root, 'instances', 'a')
      const b = join(root, 'instances', 'b')
      mkdirSync(a, { recursive: true })
      mkdirSync(join(b, 'logs'), { recursive: true })
      writeFileSync(
        join(b, 'logs', 'latest.log'),
        'InvalidMixinException: Mixin apply failed controlify\n',
      )

      const r = await ctx.cli(['diag', '--root', root, '--instance', 'a'], { offline: true })
      assertCode(r, 1, '当前实例没有日志')
      assertText(r, '没有可分析的日志', '应直说找不到')
      assertText(r, join(root, 'instances', 'a'), '应指向当前实例目录')
      assertNoText(r, 'controlify', '不能读别的实例的日志')
      assertNoText(r, 'mixin', '不能读别的实例的日志')
    },
  },

  {
    id: 'E2E-035',
    title: '真实堆空间崩溃：归因为内存，不甩锅给模组',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['diag', '--file', OOM_LOG], { offline: true })
      assertCode(r, 2, 'OutOfMemoryError')
      assertText(r, 'out-of-memory', '根因类型')
      assertText(r, '--memory', '建议应指向内存参数')
      assertNoText(r, '指向的模组', '没有证据时不能点名模组')
    },
  },

  {
    id: 'E2E-019',
    title: '--events：ndjson 事件流与最终退出码',
    tier: 0,
    async run(ctx) {
      const r = await ctx.cli(['preflight', join(FIX, 'instance-miss'), '--no-host', '--events'])
      assertCode(r, 2, 'preflight 缺依赖应退出 2')

      const lines = r.stdout
        .trim()
        .split('\n')
        .filter((l) => l !== '')
      assert(lines.length >= 3, `事件太少：${String(lines.length)}`)
      const events = lines.map((l, i) => {
        try {
          return JSON.parse(l) as Record<string, unknown>
        } catch {
          throw new Error(`第 ${String(i + 1)} 行不是 JSON：${l.slice(0, 80)}`)
        }
      })
      for (const e of events) assert(e.schemaVersion === 1, '每行都要带 schemaVersion')
      assert(
        events.some((e) => e.type === 'log'),
        '应包含 log 事件',
      )
      assert(
        events.some((e) => e.type === 'result'),
        '应包含 result 事件',
      )
      const last = events[events.length - 1]
      assert(last?.type === 'exit', '最后一行应是 exit')
      assert(last?.code === 2, `exit.code 期望 2，实际 ${String(last?.code)}`)
      assert(!r.stdout.includes('\u001b['), 'stdout 不应有 ANSI 颜色')
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
      const verdict = j.verdict
      assert(
        verdict === 'ok' || verdict === 'warn',
        `verdict 期望 ok/warn，实际 ${String(verdict)}`,
      )
      const findings = asArray(j.findings, 'findings').map((f) => asRecord(f, 'finding'))
      const missing = findings.filter((f) => f.code === 'MISSING_DEPENDENCY')
      if (missing.length > 0) {
        fail(
          `${String(missing.length)} 个依赖被判定缺失：` +
            missing.map((f) => String(f.subject ?? '?')).join(', '),
        )
      }
      const stats = asRecord(j.stats, 'stats')
      assert(asNumber(stats.mods, 'stats.mods') >= 48, 'stats.mods 期望 ≥ 48')
      assert(asNumber(stats.unresolved, 'stats.unresolved') <= 1, 'unresolved 应该只有 mixintrace')
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
      assert(j.verdict !== 'blocked', 'FO 不该被判 blocked')
      const plan = asRecord(j.plan, 'plan')
      const installs = asArray(plan.installs, 'plan.installs').map((x) => asRecord(x, 'install'))
      // 字段契约：安装项必须是可直接下载的
      for (const item of installs) {
        for (const key of ['url', 'fileName', 'size', 'requiredBy', 'confidence']) {
          assert(item[key] !== undefined, `plan.installs.${key} 缺失`)
        }
      }
      const verified = installs.filter((i) => i.confidence !== 'unverified')
      if (verified.length > 0) {
        fail(
          `FO 的依赖都没有直接证据，却给出 ${String(verified.length)} 个确定安装项：` +
            verified.map((i) => String(i.fileName ?? '?')).join(', '),
        )
      }
      const findings = asArray(j.findings, 'findings').map((x) => asRecord(x, 'finding'))
      assert(
        findings.every((f) => f.severity !== 'blocker'),
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
      const verdict = j.verdict
      assert(
        verdict === 'ok' || verdict === 'warn' || verdict === 'unknown',
        `verdict 异常：${String(verdict)}`,
      )
      const findings = asArray(j.findings, 'findings').map((f) => asRecord(f, 'finding'))
      const blockers = findings.filter((f) => f.severity === 'blocker')
      assert(
        blockers.length === 0,
        `不应有 blocker：${blockers.map((b) => String(b.code)).join(',')}`,
      )
      const stats = asRecord(j.stats, 'stats')
      assert(asNumber(stats.resolved, 'stats.resolved') >= 2, 'resolved 期望 ≥ 2')
    },
  },
  {
    id: 'E2E-104',
    title: 'CurseForge 边界：关掉镜像时不硬判 blocked，并说清「没做 mod 级校验」',
    tier: 1,
    async run(ctx) {
      /**
       * 刻意加 --no-cf-mirror：T0/T1 不该依赖第三方镜像的可用性。
       * CF 的免 key 解析（逐个 GET）由单测覆盖；真实包的手工验证见表测报告。
       */
      const r = await ctx.cli(
        ['preflight', join(FIX, 'cf-pack.zip'), '--no-host', '--no-cf-mirror'],
        { timeoutMs: 120_000 },
      )
      assertCode(r, 0, 'CF 包预检')
      assertText(r, 'CF_NO_MOD_CHECK', 'CF 应说明预检没做 mod 级校验')
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
        [
          'install',
          join(FIX, 'fo-6.5.0.mrpack'),
          '--mods-dir',
          modsDir,
          '--dry-run',
          '--include-unverified',
        ],
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
    async run(_ctx) {
      await withMcp(async (call) => {
        const res = await call('preflight_modpack', { path: join(FIX, 'demo.mrpack') })
        assert(res.isError !== true, 'preflight_modpack 不应 isError')
        const structured = asRecord(res.structuredContent, 'structuredContent')
        const verdict = structured.verdict
        assert(
          verdict === 'ok' || verdict === 'warn' || verdict === 'blocked' || verdict === 'unknown',
          `verdict 不合法：${String(verdict)}`,
        )
        assert(Array.isArray(structured.findings), 'findings 应是数组')
      })
    },
  },
  {
    id: 'E2E-108',
    title: 'update 只读检查：真实 lock 能反查，且不改文件',
    tier: 1,
    async run(ctx) {
      const lockFile = join(MCROOT, 'instances', 'fo', '.blockpilot', 'lock.json')
      const before = readFileSync(lockFile, 'utf8')
      const r = await ctx.cli(['update', '--root', MCROOT, '--instance', 'fo', '--json'], {
        timeoutMs: 300_000,
      })
      // 有更新时 exit 2（只检查不改），全部最新时 0；两者都是正常结论
      assert(
        r.code === 0 || r.code === 2,
        `update 退出码期望 0/2，实际 ${String(r.code)}${snippet(r)}`,
      )
      const j = parseJson(r, 'update --json')
      assert(asNumber(j.checked, 'checked') >= 40, 'checked 期望 ≥ 40')
      asArray(j.updates, 'updates')
      asArray(j.failed, 'failed')
      assert(asArray(j.applied, 'applied').length === 0, '未加 --apply 时 applied 必须为空')
      assert(asArray(j.applyFailed, 'applyFailed').length === 0, '未加 --apply 时不该有替换失败')
      // 默认只读是 update 最重要的承诺：检查一次不该动实例里的任何字节
      assert(readFileSync(lockFile, 'utf8') === before, '只读检查不该改写 lock.json')
    },
  },
  {
    id: 'E2E-109',
    title: 'deploy slug 不存在：说清楚，且不创建实例目录',
    tier: 1,
    async run(ctx) {
      const root = join(ctx.tmp, 'slug-root')
      const r = await ctx.cli(['deploy', 'blockpilot-no-such-pack-xyz', '--root', root], {
        timeoutMs: 120_000,
      })
      assertCode(r, 1, '不存在的 slug')
      assertText(r, /Modrinth 上找不到|查询 Modrinth 失败/, '应说明是 slug 查询失败')
      assert(!existsSync(join(root, 'instances')), '失败时不该创建实例目录')
    },
  },
  {
    id: 'E2E-110',
    title: 'assets --dry-run：首次安装的第二步只算不装',
    tier: 1,
    async run(ctx) {
      // setup 会把 asset index 落到 <root>/assets/indexes；assets 只读它展开任务。
      // 复制真实 index（不是编造的对象列表）来验证 1.21.1 的规模与「不创建 objects/」
      const root = join(ctx.tmp, 'assets-root')
      mkdirSync(join(root, 'assets', 'indexes'), { recursive: true })
      cpSync(
        join(MCROOT, 'assets', 'indexes', '17.json'),
        join(root, 'assets', 'indexes', '17.json'),
      )

      const r = await ctx.cli(['assets', '1.21.1', '--root', root, '--dry-run', '--china'], {
        timeoutMs: 180_000,
      })
      assertCode(r, 0, 'assets --dry-run')
      assertText(r, '--dry-run', '应说明只算不装')
      const m = /(\d+)\s*个对象需要下载/.exec(strip(r.stdout))
      assert(m !== null, `没找到对象数${snippet(r)}`)
      const objects = Number(m[1])
      assert(objects > 1000, `1.21.1 的 assets 对象数应 > 1000，实际 ${objects}`)
      assert(!existsSync(join(root, 'assets', 'objects')), 'dry-run 不该创建 assets/objects/')
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
        ['fabric', '1.21.1', '--root', MCROOT, '--instance', 'fo', '--loader', '0.19.3', '--china'],
        { timeoutMs: 600_000 },
      )
      assertCode(r, 0, 'fabric --china')
      assertText(r, /失败 0/, '加载器库不应该失败')
      assert(
        existsSync(
          join(
            MCROOT,
            'versions',
            'fabric-loader-0.19.3-1.21.1',
            'fabric-loader-0.19.3-1.21.1.json',
          ),
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
  {
    id: 'E2E-203',
    title: 'java install：真实下载、sha256 校验、二次复用',
    tier: 2,
    async run(ctx) {
      const root = join(ctx.tmp, 'java-root')
      // --china：Adoptium 的二进制在 GitHub Releases 上，直连实测 6–16 KB/s
      const first = await ctx.cli(['java', 'install', '21', '--root', root, '--china'], {
        timeoutMs: 900_000,
      })
      assertCode(first, 0, 'java install 21')
      assertText(first, /装好了|已存在/, '应报告安装结果')

      const javaDir = join(root, 'java')
      const exe = process.platform === 'win32' ? 'java.exe' : 'java'
      const candidates = [join(javaDir, 'bin', exe)]
      for (const name of readdirSync(javaDir)) candidates.push(join(javaDir, name, 'bin', exe))
      assert(
        candidates.some((p) => existsSync(p)),
        `托管目录里没有 ${exe}：${javaDir}`,
      )

      const scan = await ctx.cli(['java', '--root', root], { offline: true })
      assertCode(scan, 0, 'java 扫描新装的运行时')
      assertText(scan, 'Java 21', '应识别 Java 21')
      assertText(scan, javaDir, '应列出 <root>/java 下的路径')

      // 同大版本必须跳过下载：probe 会启动一次 JVM 确认版本，但不再请求 Adoptium
      const again = await ctx.cli(['java', 'install', '21', '--root', root, '--china'], {
        timeoutMs: 120_000,
      })
      assertCode(again, 0, '第二次 install')
      assertText(again, '已存在', '同大版本应跳过下载')
      assert(again.ms < 60_000, `复用不该重新下载，实际 ${String(again.ms)}ms`)
    },
  },
  {
    id: 'E2E-204',
    title: 'install 补装真实缺失依赖：下载、哈希校验、二次命中缓存',
    tier: 2,
    async run(ctx) {
      const modsDir = join(ctx.tmp, 'mods')
      // closure.mrpack 里只有 Iris；Sodium 是它在 Modrinth 上声明的真实前置。
      // 这种依赖默认按 unverified 处理（可能被 JiJ 打包），用户确认缺了才加 --include-unverified
      const args = [
        'install',
        join(FIX, 'closure.mrpack'),
        '--mods-dir',
        modsDir,
        '--include-unverified',
        '--no-host',
      ]
      const first = await ctx.cli(args, { timeoutMs: 300_000 })
      assertCode(first, 0, 'install')
      assertText(first, '开始安装', '应进入安装')

      const sodium = join(modsDir, 'sodium-fabric-0.5.13+mc1.20.1.jar')
      assert(existsSync(sodium), '补装的 sodium 没落盘')
      const sha1 = createHash('sha1').update(readFileSync(sodium)).digest('hex')
      assert(
        sha1 === 'bcdbf37d9494e405cba210d7a80ed58e756297b5',
        `文件哈希与 Modrinth 清单不符：${sha1}`,
      )

      const second = await ctx.cli(args, { timeoutMs: 300_000 })
      assertCode(second, 0, 'install 第二次')
      assertText(second, '已存在且校验通过', '第二次应命中缓存，不重复下载')
    },
  },
  {
    id: 'E2E-205',
    title: '同一 root 再装实例：复用原版/加载器，重跑不覆盖用户改动',
    tier: 2,
    async run(ctx) {
      const body = Buffer.from('e2e local mod bytes, verified by sha1/sha512')
      const sha1 = createHash('sha1').update(body).digest('hex')
      const sha512 = createHash('sha512').update(body).digest('hex')

      // 模拟「用户在自己熟悉的 root 里再建一个实例」：原版、加载器、assets 都已共享，
      // deploy 只该下载包内新增文件。下载源用本地服务，避免依赖某个真实 mod 的线上字节。
      const server = createServer((_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        })
        res.end(body)
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
      const port = (server.address() as AddressInfo).port
      const packPath = join(ctx.tmp, 'local-pack.mrpack')
      writeFileSync(
        packPath,
        zipSync({
          'modrinth.index.json': strToU8(
            JSON.stringify({
              formatVersion: 1,
              game: 'minecraft',
              versionId: '1.0.0',
              name: 'E2E local pack',
              dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.19.3' },
              files: [
                {
                  path: 'mods/e2e-local.jar',
                  hashes: { sha1, sha512 },
                  env: { client: 'required', server: 'required' },
                  downloads: [`http://127.0.0.1:${String(port)}/e2e-local.jar`],
                  fileSize: body.length,
                },
              ],
            }),
          ),
          'overrides/config/e2e-local.toml': strToU8('from-pack = true\n'),
        }),
      )

      const instance = 'deploy-e2e'
      const gameDir = join(MCROOT, 'instances', instance)
      const args = [
        'deploy',
        packPath,
        '--root',
        MCROOT,
        '--instance',
        instance,
        '--allow-host',
        '127.0.0.1',
        '--china',
      ]
      try {
        rmSync(gameDir, { recursive: true, force: true })
        const first = await ctx.cli(args, { timeoutMs: 300_000 })
        assertCode(first, 0, 'deploy 首次')
        assertText(first, '装好了', '应完成部署')

        const mod = join(gameDir, 'mods', 'e2e-local.jar')
        assert(existsSync(mod), '包内模组没落盘')
        assert(readFileSync(mod).equals(body), '下载内容与哈希源不一致')

        const lock = JSON.parse(
          readFileSync(join(gameDir, '.blockpilot', 'lock.json'), 'utf8'),
        ) as { complete?: boolean; files?: { path?: string; sha1?: string }[] }
        assert(lock.complete === true, 'lock.complete 应为 true')
        assert(lock.files?.length === 1, `lock 条目数期望 1，实际 ${String(lock.files?.length)}`)
        assert(lock.files?.[0]?.path === 'mods/e2e-local.jar', 'lock 路径不对')
        assert(lock.files?.[0]?.sha1 === sha1, 'lock 哈希不对')

        const override = join(gameDir, 'config', 'e2e-local.toml')
        assert(existsSync(override), 'overrides 没落地')

        // 真实用户会改 config；重跑 deploy 必须保留，只有 --overwrite-overrides 才覆盖
        writeFileSync(override, 'from-pack = false\n')
        const second = await ctx.cli(args, { timeoutMs: 300_000 })
        assertCode(second, 0, 'deploy 重跑')
        assert(
          readFileSync(override, 'utf8') === 'from-pack = false\n',
          '重跑不该覆盖用户改过的 overrides',
        )

        const third = await ctx.cli([...args, '--overwrite-overrides'], { timeoutMs: 300_000 })
        assertCode(third, 0, 'deploy --overwrite-overrides')
        assert(
          readFileSync(override, 'utf8') === 'from-pack = true\n',
          '--overwrite-overrides 应恢复包内版本',
        )

        const verify = await ctx.cli(
          ['verify', '--root', MCROOT, '--instance', instance, '--json'],
          { offline: true },
        )
        assertCode(verify, 0, '部署后 verify')
        const report = parseJson(verify, 'verify --json')
        assert(report.okAll === true, '部署后所有文件应与 lock 一致')
      } finally {
        server.close()
        rmSync(gameDir, { recursive: true, force: true })
      }
    },
  },

  // ---------------- T3 真实启动 ----------------
  {
    id: 'E2E-301',
    title: '真实启动：FO 实例进游戏后按时结束',
    tier: 3,
    async run(ctx) {
      const stop = process.env.BP_E2E_STOP ?? '60'
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

      const logPath = extractLogPath(strip(r.stdout))
      assert(logPath !== undefined, '没打印会话日志路径')
      assert(existsSync(logPath), `会话日志不存在：${logPath}`)
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
        ['run', 'fabric-loader-0.19.3-1.21.1', '--root', MCROOT, '--instance', 'fo', '--java', bad],
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
          [
            'deploy',
            packPath,
            '--root',
            MCROOT,
            '--instance',
            instance,
            '--china',
            // mrpack 的下载域名白名单默认只允许 Modrinth 规范里的域名；
            // 这条用例故意用本地服务喂坏字节，必须显式放行
            '--allow-host',
            '127.0.0.1',
          ],
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

  if (process.env.CI !== undefined && opts.tiers.some((t) => t > 1)) {
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
        outcomes.push({
          id: c.id,
          title: c.title,
          tier: c.tier,
          status: 'PASS',
          ms: Date.now() - started,
        })
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
    process.stderr.write(
      `执行器崩了：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    )
    process.exit(1)
  },
)
