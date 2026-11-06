#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { NetworkError } from '../core/http.js'
import { applyProxy } from '../core/proxy.js'
import { dirname, join } from 'node:path'

import { createPreflight } from '../core/preflight/index.js'
import type { Finding, PreflightReport } from '../core/preflight/types.js'
import { createInstaller } from '../core/download/index.js'
import { chinaFirstSources, defaultSources } from '../core/download/sources.js'
import type { InstallResult } from '../core/download/types.js'
import { createJavaScan } from '../core/java/index.js'
import { createJavaInstall } from '../core/java/install.js'
import type { JavaInstallResult } from '../core/java/install.js'
import { selectJava } from '../core/java/select.js'
import type { JavaScanResult } from '../core/java/types.js'
import { createLaunchPlan } from '../core/launch/index.js'
import { createLauncher } from '../core/launch/run.js'
import { listLogs } from '../core/launch/logfile.js'
import { createDiagnose } from '../core/diagnostics/index.js'
import type { DiagResult } from '../core/diagnostics/index.js'
import type { RunResult } from '../core/launch/run.js'
import type { LaunchPlan } from '../core/launch/plan.js'
import { defaultRoot, LayoutError, resolveLayout } from '../core/layout.js'
import type { Layout } from '../core/layout.js'
import { authStorePath, createLogin, isAuthError, loadStore, removeAccount, resolveAccount } from '../core/auth/index.js'
import type { AuthAccount } from '../core/auth/types.js'
import { createVanillaSetup, pickSources } from '../core/setup/vanilla.js'
import { VersionNotFoundError } from '../core/version/fetch.js'
import { createAssetsSetup } from '../core/setup/assets.js'
import { createFabricSetup } from '../core/setup/fabric.js'
import type { FabricSetupResult } from '../core/setup/fabric.js'
import { createDeploy } from '../core/deploy.js'
import type { DeployResult } from '../core/deploy.js'
import { readPackFile } from '../core/preflight/read-pack.js'
import { detectHost } from '../core/host.js'
import { ModrinthSource } from '../sources/modrinth.js'
import { C, consume, createInterrupt, humanBytes } from './ui.js'

const SEVERITY_MARK: Record<Finding['severity'], string> = {
  blocker: `${C.red}✗${C.reset}`,
  warning: `${C.yellow}!${C.reset}`,
  info: `${C.cyan}i${C.reset}`,
}

/** 命令行参数不合法。给稳定 code，别让用户看到 `unexpected error: Error: ...`。 */
class UsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'UsageError'
  }
}

const VERDICT_TEXT: Record<PreflightReport['verdict'], string> = {
  ok: `${C.green}OK${C.reset}`,
  warn: `${C.yellow}WARN${C.reset}`,
  blocked: `${C.red}BLOCKED${C.reset}`,
  unknown: `${C.yellow}UNKNOWN${C.reset}`,
}

/**
 * verdict → 退出码。
 *
 * `unknown` 给 0 是有意的：它的意思是「没验到」，不是「验出问题」。
 * 这条契约在 E2E-004「unknown 不能当违规」里钉死了——把「没证据」当成
 * 失败，会让离线场景（模组元数据拿不到）下正常实例全都报错。
 *
 * 代价是脚本无法只靠退出码区分「验过且通过」和「什么都没验到」，
 * 需要区分时用 `--json` 读 verdict 字段。
 */
function verdictExit(verdict: PreflightReport['verdict']): number {
  switch (verdict) {
    case 'ok':
    case 'warn':
    case 'unknown':
      return 0
    case 'blocked':
      return 2
  }
}

function renderHuman(r: PreflightReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot preflight${C.reset}`)
  lines.push('')
  lines.push(`  verdict   ${VERDICT_TEXT[r.verdict]}`)
  lines.push(
    `  mods      ${r.stats.mods}  ${C.dim}(resolved ${r.stats.resolved}, unresolved ${r.stats.unresolved})${C.reset}`,
  )
  lines.push('')

  if (r.findings.length === 0) {
    // 「没有发现问题」是一个结论。没东西可查、或者什么都没查成的时候，
    // 说这句话等于给了一个假的通过——用户会跳过后面所有步骤。
    if (r.stats.mods === 0) {
      lines.push(`  ${C.yellow}没有可检查的模组${C.reset}`)
      lines.push(
        `  ${C.dim}清单里没有 mods/ 下的文件。如果包里有模组，检查 path 是不是多套了一层目录${C.reset}`,
      )
    } else if (r.verdict === 'unknown') {
      lines.push(`  ${C.yellow}这次没有验成${C.reset}`)
      lines.push(`  ${C.dim}模组元数据没取到，不代表包没问题${C.reset}`)
    } else {
      lines.push(`  ${C.green}没有发现问题${C.reset}`)
    }
    lines.push('')
  } else {
    const order: Finding['severity'][] = ['blocker', 'warning', 'info']
    for (const sev of order) {
      const group = r.findings.filter((f) => f.severity === sev)
      for (const f of group) {
        lines.push(`  ${SEVERITY_MARK[f.severity]} ${C.bold}${f.code}${C.reset}  ${f.message}`)
        if (f.hint !== undefined) lines.push(`    ${C.dim}→ ${f.hint}${C.reset}`)
        if (f.subject !== undefined) lines.push(`    ${C.dim}subject: ${f.subject}${C.reset}`)
        lines.push('')
      }
    }
  }

  if (r.plan.installs.length > 0) {
    lines.push(`${C.bold}修复计划${C.reset}`)
    lines.push('')
    for (const p of r.plan.installs) {
      const uncertain = p.confidence === 'unverified'
      const mark = uncertain ? `${C.yellow}?${C.reset}` : `${C.green}+${C.reset}`
      lines.push(
        `  ${mark} ${p.displayName}  ${C.dim}${p.fileName} · ${humanBytes(p.size)}${C.reset}`,
      )
      lines.push(
        `    ${C.dim}被 ${p.requiredBy.join('、')} 依赖 · ${p.projectId}/${p.versionId}${C.reset}` +
          (uncertain ? `  ${C.yellow}未验证：可能已被某个模组内置${C.reset}` : ''),
      )
    }
    lines.push('')
  }

  if (r.plan.manual.length > 0) {
    lines.push(`${C.bold}需要人工处理${C.reset}`)
    lines.push('')
    for (const m of r.plan.manual) {
      const why =
        m.reason === 'no-compatible-version'
          ? '找不到兼容当前游戏版本与加载器的版本'
          : '该版本没有可下载文件'
      // 名字给人看，id 留给搜索与脚本
      const label = m.displayName === undefined ? m.projectId : `${m.displayName} (${m.projectId})`
      lines.push(`  ${C.yellow}?${C.reset} ${label}  ${C.dim}${why}${C.reset}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function usage(): void {
  process.stdout.write(`BlockPilot — AI-drivable launcher core

  blockpilot preflight <target> [--json] [--no-host]
  blockpilot install   <target> --mods-dir <dir> [--dry-run] [--china] [--include-unverified]
  blockpilot java
  blockpilot setup  <version> [--root <dir>] [--instance <name>] [--china] [--dry-run]
  blockpilot assets <version> [--root <dir>] [--china] [--dry-run] [--concurrency <n>]
  blockpilot fabric <gameVersion> [--root <dir>] [--instance <name>] [--loader <ver>] [--china]
  blockpilot deploy <pack.mrpack> [--root <dir>] [--instance <name>] [--china]
  blockpilot login     [--root <dir>] [--client-id <uuid>]
  blockpilot accounts  [--root <dir>] [--remove <name|uuid>]
  blockpilot launch <version> [--root <dir>] [--instance <name>] [--java <path>] [--memory <MB>] [--account <name>] [--offline] [--raw]
  blockpilot run    <version> [--root <dir>] [--instance <name>] [--memory <MB>] [--account <name>] [--offline] [--quiet] [--stop <秒>]

  所有子命令通用：  --proxy <url>   走 HTTP 代理（也读 HTTPS_PROXY 环境变量）
                    影响元数据、下载与 installer；如 http://127.0.0.1:1081

  <target>  .mrpack / CurseForge 的 zip（带 manifest.json），或实例目录
            （MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录）
            CF 包只能预检版本与 Java；mod 级校验要 API key，见 ADR-0021

  install   先预检，再把 plan.installs 里的文件下载到 --mods-dir
            --dry-run 只打印计划，不下载
            --china   镜像优先（mcim 提到直连之前）
            --include-unverified  连「未验证」的依赖一起装
                        整合包可能把依赖打在 jar-in-jar 里，默认不装，装完先 preflight 实例确认
  preflight --json    输出结构化报告
            --no-host 跳过本机 Java / 内存检测（省 1–3 秒）
  java      列出本机可用的 Java 运行时
  java install <major> [--root <dir>]   从 Adoptium 下载并解压 JRE 到 <root>/java
  login     用微软账号登录（设备码：给你一个网址和一个短码，在浏览器里输）
            需要自己的 Azure 应用 id：--client-id 或 BLOCKPILOT_CLIENT_ID
            client id 注册一次就够，见 ADR-0024
  accounts  列出已保存的账号；--remove <name|uuid> 删掉一个

  --root    数据根目录，默认 ${defaultRoot()}
            用户只需要选这一次；实例目录由 --instance 自动派生
  setup     安装原版：client jar + libraries + assetIndex + 解压 natives
  assets    下载 assets 对象（音效/语言/字体，约 600 MB、3000+ 文件）
            不装也能启动，但没有声音和部分字体
  fabric    安装 Fabric 加载器：取 profile → 写版本 JSON → 下载 loader 库
            之后用 launch / run 加 fabric-loader-<ver>-<mc> 启动
  deploy    从 .mrpack 一次装完：原版 → 加载器 → 模组 → overrides
            装完直接给出可用的启动命令
  launch    生成启动命令（只打印，不启动）
  run       真的启动游戏，转发日志并落盘到 <实例>/logs/
            --quiet 只显示 ERROR 级日志
            --stop <秒> 到时自动结束（测试用）
            --account <name>  用指定账号（在线）；缺省用上次登录的那个
            --offline         强制离线模式，不读账号存档
  logs      列出会话日志
  diag      分析最近的会话日志，把异常归类成可理解的结论
            --file <path> 指定日志；默认取最新一份
            --json 输出结构化结论（verdict / primary / culprits），给脚本用

`)
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

/**
 * 每个子命令接受的 flag。`true` 表示这个 flag 后面必须跟一个值。
 *
 * 为什么要这张表：以前未知参数被静默忽略，`--json` 拼成 `--jsno` 依然退出 0，
 * 脚本拿到一段人类可读文本去 JSON.parse，错在别处；`--root` 忘了写路径则
 * 悄悄装进默认目录。**静默做错事比报错难查得多。**
 */
const COMMAND_FLAGS: Record<string, Readonly<Record<string, boolean>>> = {
  preflight: { '--json': false, '--no-host': false },
  install: {
    '--mods-dir': true,
    '--dry-run': false,
    '--include-unverified': false,
    '--no-host': false,
    '--china': false,
  },
  java: { '--root': true, '--china': false },
  login: { '--root': true, '--client-id': true },
  accounts: { '--root': true, '--remove': true },
  setup: { '--root': true, '--instance': true, '--dry-run': false, '--china': false },
  assets: { '--root': true, '--dry-run': false, '--china': false, '--concurrency': true },
  fabric: { '--root': true, '--instance': true, '--loader': true, '--china': false },
  deploy: { '--root': true, '--instance': true, '--china': false, '--java': true },
  launch: {
    '--root': true,
    '--instance': true,
    '--raw': false,
    '--java': true,
    '--memory': true,
    '--user': true,
    '--china': false,
    '--account': true,
    '--offline': false,
  },
  run: {
    '--root': true,
    '--instance': true,
    '--quiet': false,
    '--stop': true,
    '--java': true,
    '--memory': true,
    '--user': true,
    '--china': false,
    '--account': true,
    '--offline': false,
  },
  logs: { '--root': true, '--instance': true },
  diag: { '--root': true, '--instance': true, '--file': true, '--json': false },
}

/** 找第一个不认识的 flag，或需要值却没给值的 flag。返回人话，没问题返回 undefined。 */
function validateFlags(
  args: readonly string[],
  spec: Readonly<Record<string, boolean>>,
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined || !a.startsWith('--')) continue

    const needsValue = spec[a]
    if (needsValue === undefined) return `未知参数 ${a}`
    if (!needsValue) continue

    const value = args[i + 1]
    // 值不能是另一个 flag：`--root --china` 是少写了路径，不是要把 root 设成 "--china"
    if (value === undefined || value.startsWith('--')) return `${a} 需要一个值`
    i += 1
  }
  return undefined
}

/**
 * 解析 --memory。
 *
 * 用户会照教程填 8192、16384，也会手滑填 abc、-1、0。以前这些值原样拼成
 * `-XmxNaNM` / `-Xmx-1M` 传给 JVM，JVM 回一句 `Unrecognized option` 就退出——
 * 用户完全联想不到是自己参数写错了。
 */
function parseMemoryArg(arg: string | undefined): number | undefined {
  if (arg === undefined) return undefined
  if (!/^\d+$/.test(arg)) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory 要一个整数（单位 MB），收到：${arg}`,
      '例：--memory 4096',
    )
  }
  const mib = Number(arg)
  if (mib < 512) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory ${mib} 太小，游戏起不来`,
      '至少 1024；大型整合包 4096 起',
    )
  }
  if (mib > 65536) {
    throw new UsageError(
      'BAD_MEMORY',
      `--memory ${mib} 超出合理范围`,
      '不要超过物理内存的一半；8192 / 16384 已经够大',
    )
  }
  return mib
}

/**
 * 离线用户名的合法性提示（不阻断）。
 *
 * MC 的离线名只认字母、数字、下划线，长度 1–16。中文名单机能进，但联机时
 * 服务端会拒绝或显示乱码——这是新手最常踩的坑之一，网上的教程都会特意提醒。
 * 单人确实能玩，所以只提醒，不拦。
 */
function warnOfflineUsername(name: string): void {
  if (/^[A-Za-z0-9_]{1,16}$/.test(name)) return
  process.stderr.write(
    `${C.yellow}注意${C.reset}：离线用户名「${name}」不符合规则（仅字母/数字/下划线，1–16 位），联机会被拒\n` +
      `${C.dim}单人还能进；要联机请换成英文名，如 Steve${C.reset}\n`,
  )
}

async function runPreflight(argv: readonly string[]): Promise<number> {
  const target = argv[0]
  if (target === undefined || target.startsWith('--')) {
    usage()
    return 1
  }
  const asJson = argv.includes('--json')
  const signal = createInterrupt().signal

  const host = argv.includes('--no-host') ? undefined : await detectHost()
  const op = createPreflight({
    target,
    source: new ModrinthSource(),
    ...(host === undefined ? {} : { host }),
  })

  return consume(
    op,
    {
      ...(asJson ? { progress: () => {}, log: () => {} } : {}),
      result: (report) => {
        if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        else process.stdout.write(renderHuman(report))
        return verdictExit(report.verdict)
      },
    },
    signal,
  )
}

async function runInstall(argv: readonly string[]): Promise<number> {
  const target = argv[0]
  const modsDirArg = argOf(argv, '--mods-dir')
  if (target === undefined || target.startsWith('--') || modsDirArg === undefined) {
    usage()
    return 1
  }
  const dryRun = argv.includes('--dry-run')
  const includeUnverified = argv.includes('--include-unverified')
  const signal = createInterrupt().signal

  process.stderr.write(`${C.dim}· preflight${C.reset}\n`)
  const host = argv.includes('--no-host') ? undefined : await detectHost()
  const preflight = createPreflight({
    target,
    source: new ModrinthSource(),
    ...(host === undefined ? {} : { host }),
  })
  let report: PreflightReport | undefined
  const preflightCode = await consume(
    preflight,
    {
      progress: () => {},
      log: () => {},
      result: (value) => {
        report = value
        return 0
      },
    },
    signal,
  )
  if (preflightCode !== 0 || report === undefined) return 1

  process.stdout.write(renderHuman(report))

  const installs = report.plan.installs.filter(
    (i) => includeUnverified || i.confidence === 'verified',
  )
  const heldBack = report.plan.installs.length - installs.length
  if (installs.length === 0) {
    process.stdout.write(`${C.green}没有需要自动补装的东西。${C.reset}\n`)
    if (heldBack > 0) {
      process.stdout.write(
        `${C.dim}有 ${heldBack} 个依赖未验证（整合包可能用 jar-in-jar 内置了它们）。` +
          `确认缺再装：加 --include-unverified${C.reset}\n`,
      )
    }
    process.stdout.write('\n')
    // 本命令只对「装」负责：没有要补的依赖就是成功，哪怕预检因为宿主机没 Java 判了
    // BLOCKED（那是「能不能跑」的问题，归 preflight / run 管）。预检结论照旧打印在上面；
    // 脚本要按它判定，用 `preflight --json`。
    if (report.verdict === 'blocked' || report.verdict === 'unknown') {
      process.stdout.write(
        `${C.dim}预检结论 ${report.verdict} 说的是「这包能不能跑」，不影响本命令的退出码。${C.reset}\n\n`,
      )
    }
    return 0
  }

  const modsDir = join(process.cwd(), modsDirArg)
  const totalBytes = installs.reduce((s, i) => s + i.size, 0)
  process.stdout.write(
    `${C.bold}开始安装${C.reset}  ${installs.length} 个文件 · ${humanBytes(totalBytes)} → ${modsDir}\n\n`,
  )

  if (dryRun) {
    process.stdout.write(`${C.yellow}--dry-run${C.reset}：只打印计划，不下载\n\n`)
    return 0
  }

  const installer = createInstaller({
    plan: { installs, manual: report.plan.manual },
    modsDir,
    sources: argv.includes('--china') ? chinaFirstSources() : defaultSources(),
  })

  const installCode = await consume(
    installer,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}      `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        const data = ev.data as { file?: string; bytes?: number; source?: string; error?: string } | undefined
        if (ev.code === 'download.ok' && data?.file !== undefined) {
          process.stderr.write(
            `\r${C.green}↓${C.reset} ${data.file}  ${C.dim}${humanBytes(data.bytes ?? 0)} · ${data.source ?? ''}${C.reset}\n`,
          )
        } else if (ev.code === 'download.cached' && data?.file !== undefined) {
          process.stderr.write(`\r${C.cyan}=${C.reset} ${data.file}  ${C.dim}已存在且校验通过${C.reset}\n`)
        } else if (ev.code === 'download.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${data?.file ?? ''}  ${C.dim}${data?.error ?? ''}${C.reset}\n`)
        }
      },
      result: (result) => {
        process.stdout.write('\n')
        process.stdout.write(
          `  ${C.green}完成${C.reset} ${result.downloaded.length} 个，` +
            `${result.failed.length > 0 ? C.red : C.dim}失败 ${result.failed.length} 个${C.reset}，` +
            `共 ${humanBytes(result.totalBytes)}\n`,
        )
        for (const f of result.failed) {
          process.stdout.write(`  ${C.red}✗${C.reset} ${f.fileName}  ${C.dim}${f.error}${C.reset}\n`)
        }

        // BMCLAPI 的协议要求在可视部分标明来源，所以这一行不是可选装饰。
        const credits = [...new Set(result.downloaded.map((d) => d.credit).filter((c) => c !== undefined))]
        if (credits.length > 0) {
          process.stdout.write(`  ${C.dim}资源来源：${credits.join('、')}${C.reset}\n`)
        }
        process.stdout.write('\n')
        return result.failed.length > 0 ? 2 : 0
      },
    },
    signal,
  )
  return installCode === 1 ? 1 : installCode
}

function renderJava(r: JavaScanResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot java${C.reset}`)
  lines.push('')

  if (r.installs.length === 0) {
    lines.push(`  ${C.red}没有找到可用的 Java${C.reset}`)
    lines.push(
      `  ${C.dim}MC 1.16.5 及以下要 Java 8，1.17–1.20.4 要 Java 17，1.20.5+ 要 Java 21${C.reset}`,
    )
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`  找到 ${r.installs.length} 个`)
  lines.push('')
  for (const j of r.installs) {
    const vendor = j.vendor ?? '未知厂商'
    lines.push(
      `  ${C.green}Java ${j.major}${C.reset}  ${C.dim}${j.version.padEnd(14)}${vendor.padEnd(24)}${j.path}${C.reset}`,
    )
  }
  lines.push('')

  if (r.rejected.length > 0) {
    lines.push(`  ${C.dim}${r.rejected.length} 个候选路径探测失败（不是 JVM 或不可执行）${C.reset}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function runJavaInstall(argv: readonly string[]): Promise<number> {
  const majorArg = argv[0]
  if (majorArg === undefined || majorArg.startsWith('--')) {
    usage()
    return 1
  }
  const major = Number(majorArg)
  if (!Number.isFinite(major) || major < 8) {
    process.stderr.write(`${C.red}无效的 Java 大版本：${majorArg}${C.reset}\n`)
    return 1
  }

  const root = argOf(argv, '--root') ?? defaultRoot()
  const layout = resolveLayout(root, 'default')
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}安装 Java${C.reset} ${major} → ${join(layout.root, 'java')}\n\n`)

  const op = createJavaInstall({
    layout,
    major,
    sources: pickSources(argv.includes('--china')),
  })

  return consume(
    op,
    {
      log: (ev) => {
        const d = ev.data as
          | { release?: string; size?: number; bytes?: number; cached?: boolean; credit?: string }
          | undefined
        if (ev.code === 'java.download') {
          process.stderr.write(`${C.dim}· ${d?.release ?? ''} · ${humanBytes(d?.size ?? 0)}${C.reset}\n`)
        } else if (ev.code === 'java.extract') {
          // 命中本地缓存时一个字节都没下，别说成「下载完成」
          const how = d?.cached === true ? '使用已下载的包' : '下载完成'
          const from = d?.credit === undefined ? '' : ` · ${d.credit}`
          process.stderr.write(
            `${C.dim}· ${how} ${humanBytes(d?.bytes ?? 0)}${from}，解压中…${C.reset}\n`,
          )
        }
      },
      result: (r) => {
        process.stdout.write(
          `  ${C.green}${r.skipped ? '已存在' : '装好了'}${C.reset}  Java ${r.java.major} · ${r.java.version}\n`,
        )
        process.stdout.write(`  ${C.dim}${r.java.path}${C.reset}\n\n`)
        return 0
      },
    },
    signal,
  )
}

async function runJava(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'install') return runJavaInstall(argv.slice(1))

  const signal = createInterrupt().signal
  return consume(
    createJavaScan(),
    {
      log: () => {},
      result: (r) => {
        process.stdout.write(renderJava(r))
        return 0
      },
    },
    signal,
  )
}

/** 命令可能长达几千字符，classpath 折叠成一个占位符。 */
function compactArgs(plan: LaunchPlan, raw: boolean): string {
  const args = [...plan.args]
  if (raw) return [plan.java, ...args].join(' ')
  const cpIndex = args.indexOf('-cp')
  if (cpIndex !== -1) {
    args[cpIndex + 1] = `<${plan.classpath.length} jars>`
  } else {
    const cpArg = args.findIndex((a) => a.startsWith('-cp') && a.length > 3)
    if (cpArg !== -1) args[cpArg] = `-cp <${plan.classpath.length} jars>`
  }
  return [plan.java, ...args].join(' ')
}

function renderLaunch(plan: LaunchPlan, raw: boolean): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot launch${C.reset}`)
  lines.push('')
  lines.push(`  版本      ${plan.versionId}`)
  const who = plan.mode === 'online' ? `${plan.playerName}（正版）` : `${plan.playerName}（离线）`
  lines.push(`  身份      ${who}`)
  lines.push(`  Java      ${plan.java}`)
  lines.push(`  主类      ${plan.mainClass}`)
  lines.push(`  类路径    ${plan.classpath.length} 个 jar`)
  lines.push(`  工作目录  ${plan.cwd}`)
  lines.push('')

  lines.push(`${C.bold}命令${C.reset}`)
  lines.push(`  ${C.dim}${compactArgs(plan, raw)}${C.reset}`)
  lines.push('')

  if (plan.missing.length > 0) {
    lines.push(`${C.yellow}文件还没装齐${C.reset}  ${plan.missing.length} 个缺失`)
    lines.push('')
    for (const m of plan.missing.slice(0, 8)) {
      lines.push(`  ${C.dim}${m}${C.reset}`)
    }
    if (plan.missing.length > 8) {
      lines.push(`  ${C.dim}…还有 ${plan.missing.length - 8} 个${C.reset}`)
    }
    lines.push('')
  } else {
    lines.push(`${C.green}所有依赖文件都在位${C.reset}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** 三个子命令共用「挑 Java」用例；core 负责选，这里只渲染结局。 */
async function pickJavaOrReport(
  versionId: string | undefined,
  layout: Layout,
  signal: AbortSignal,
  explicit: string | undefined,
): Promise<string | undefined> {
  const outcome = await selectJava({
    ...(versionId === undefined ? {} : { versionId }),
    layoutRoot: layout.root,
    // 传整个 layout：只有它能读到 versions/<id>/<id>.json 里的 javaVersion
    layout,
    signal,
    ...(explicit === undefined ? {} : { explicit }),
  })
  if (outcome.ok) return outcome.path
  process.stderr.write(`${C.red}${outcome.message}${C.reset}\n`)
  // 只说「没有」而不说怎么办，用户下一步只能去搜。给一条能直接敲的命令
  if (outcome.needMajor !== undefined) {
    process.stderr.write(`${C.dim}可以装一个：blockpilot java install ${outcome.needMajor}${C.reset}\n`)
  }
  return undefined
}

/**
 * 为启动挑账号。
 *
 * 三种情况分开处理，因为「用户此刻想要什么」不同：
 *   --offline     明确要离线，不问存档
 *   有存档        用它（过期就自动刷新）
 *   没存档        离线，并在 stderr 说明一句
 *
 * 点名要 `--account` 却拿不到时退出码非零：他要的是在线身份，
 * 悄悄用离线身份进去，朋友会看到「这不是你」。
 */
async function resolveAuth(
  argv: readonly string[],
  layout: ReturnType<typeof resolveLayout>,
  signal: AbortSignal,
): Promise<{ ok: true; account?: AuthAccount } | { ok: false }> {
  if (argv.includes('--offline')) return { ok: true }

  const selector = argOf(argv, '--account')
  try {
    const r = await resolveAccount({
      storePath: authStorePath(layout.root),
      ...(selector === undefined ? {} : { selector }),
      signal,
    })
    if (r.kind === 'online') {
      const note = r.refreshed ? '（令牌已刷新）' : ''
      process.stderr.write(`${C.dim}· 账号 ${r.account.name}${note}${C.reset}\n`)
      return { ok: true, account: r.account }
    }
    process.stderr.write(`${C.dim}· 离线模式：${r.reason}${C.reset}\n`)
    return { ok: true }
  } catch (err) {
    if (!isAuthError(err)) throw err
    process.stderr.write(`${C.red}${err.code}${C.reset}: ${err.message}\n`)
    if (err.hint !== undefined) process.stderr.write(`${C.dim}${err.hint}${C.reset}\n`)
    return { ok: false }
  }
}

function runLogin(argv: readonly string[]): Promise<number> {
  const root = argOf(argv, '--root') ?? defaultRoot()
  const layout = resolveLayout(root, 'default')
  const clientId = argOf(argv, '--client-id') ?? process.env['BLOCKPILOT_CLIENT_ID'] ?? ''
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.bold}BlockPilot login${C.reset}  ${C.dim}微软账号 · 设备码${C.reset}\n\n`)

  return consume(
    createLogin({ clientId, storePath: authStorePath(layout.root) }),
    {
      log: (ev) => {
        if (ev.code === 'auth.device_code') {
          const d = ev.data as { userCode: string; verificationUri: string; expiresInSec: number }
          process.stdout.write('\n')
          process.stdout.write(`  ${C.bold}1.${C.reset} 打开  ${C.cyan}${d.verificationUri}${C.reset}\n`)
          process.stdout.write(`  ${C.bold}2.${C.reset} 输入  ${C.bold}${d.userCode}${C.reset}\n\n`)
          process.stdout.write(
            `  ${C.dim}等待授权…（${Math.round(d.expiresInSec / 60)} 分钟内有效，Ctrl+C 取消）${C.reset}\n\n`,
          )
          return
        }
        if (ev.code === 'auth.step') {
          const step = (ev.data as { step?: string } | undefined)?.step ?? ''
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
      result: (acc) => {
        process.stdout.write(`  ${C.green}登录成功${C.reset}  ${C.bold}${acc.name}${C.reset}\n`)
        process.stdout.write(`  ${C.dim}uuid ${acc.uuid}${C.reset}\n`)
        process.stdout.write(
          `  ${C.dim}令牌有效至 ${new Date(acc.expiresAt).toLocaleString()}${C.reset}\n\n`,
        )
        return 0
      },
    },
    signal,
  )
}

async function runAccounts(argv: readonly string[]): Promise<number> {
  const root = argOf(argv, '--root') ?? defaultRoot()
  const layout = resolveLayout(root, 'default')
  const storePath = authStorePath(layout.root)
  const remove = argOf(argv, '--remove')

  process.stdout.write('\n')
  if (remove !== undefined) {
    const removed = removeAccount(storePath, remove)
    process.stdout.write(
      removed
        ? `  ${C.green}已移除${C.reset}  ${remove}\n`
        : `  ${C.yellow}没有这个账号${C.reset}  ${remove}\n`,
    )
    process.stdout.write('\n')
    return removed ? 0 : 1
  }

  const store = loadStore(storePath)
  process.stdout.write(`  ${C.dim}${storePath}${C.reset}\n\n`)
  if (store.accounts.length === 0) {
    process.stdout.write(`  ${C.dim}还没有账号。跑一次 blockpilot login 会加一个。${C.reset}\n\n`)
    return 0
  }

  const now = Date.now()
  for (const a of store.accounts) {
    const active = a.uuid === store.active ? `${C.green}*${C.reset}` : ' '
    const state =
      a.expiresAt > now + 60_000 ? `${C.dim}令牌有效${C.reset}` : `${C.yellow}令牌过期，启动时自动刷新${C.reset}`
    const refreshable = a.refreshToken === undefined ? `${C.red}不可刷新${C.reset}` : state
    process.stdout.write(`  ${active} ${C.bold}${a.name}${C.reset}  ${C.dim}${a.uuid}${C.reset}\n`)
    process.stdout.write(`     ${refreshable}\n`)
  }
  process.stdout.write('\n')
  return 0
}

async function runLaunch(argv: readonly string[]): Promise<number> {
  const versionId = argv[0]
  if (versionId === undefined || versionId.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const raw = argv.includes('--raw')
  const signal = createInterrupt().signal

  // 参数校验放在所有 I/O 之前：--memory 写错时不该先去探测 Java、解析版本，
  // 让用户等几秒才看到「其实是你参数写错了」
  const maxMemoryMiB = parseMemoryArg(argOf(argv, '--memory'))

  const javaPath = await pickJavaOrReport(versionId, layout, signal, argOf(argv, '--java'))
  if (javaPath === undefined) return 1

  const auth = await resolveAuth(argv, layout, signal)
  if (!auth.ok) return 1

  const offlineUsername = argOf(argv, '--user') ?? 'Player'
  // 有正版账号时名字来自账号，--user 不生效，别误报
  if (auth.account === undefined) warnOfflineUsername(offlineUsername)
  const op = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: offlineUsername,
    ...(auth.account === undefined ? {} : { account: auth.account }),
    ...(maxMemoryMiB === undefined ? {} : { maxMemoryMiB }),
    mirror: argv.includes('--china'),
  })

  return consume(
    op,
    {
      result: (plan) => {
        process.stdout.write(renderLaunch(plan, raw))
        return 0
      },
    },
    signal,
  )
}

async function runSetup(argv: readonly string[]): Promise<number> {
  const versionId = argv[0]
  if (versionId === undefined || versionId.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const dryRun = argv.includes('--dry-run')
  const china = argv.includes('--china')
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}根目录${C.reset}  ${layout.root}\n`)
  process.stdout.write(`  ${C.dim}实例${C.reset}    ${layout.instanceId} → ${layout.gameDir}\n`)
  process.stdout.write('\n')

  const op = createVanillaSetup({
    layout,
    versionId,
    dryRun,
    sources: pickSources(china),
    mirror: china,
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        const data = ev.data as { file?: string; source?: string; error?: string } | undefined
        if (ev.code === 'setup.ok' && data?.file !== undefined) {
          process.stderr.write(`\r${C.green}↓${C.reset} ${data.file}  ${C.dim}${data.source ?? ''}${C.reset}\n`)
        } else if (ev.code === 'setup.cached' && data?.file !== undefined) {
          process.stderr.write(`\r${C.cyan}=${C.reset} ${data.file}\n`)
        } else if (ev.code === 'setup.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${data?.file ?? ''}  ${data?.error ?? ''}\n`)
        } else if (ev.code === 'setup.tasks') {
          const t = ev.data as { tasks: number; totalBytes: number } | undefined
          if (t !== undefined) {
            process.stderr.write(`${C.dim}· ${t.tasks} 个文件 · ${humanBytes(t.totalBytes)}${C.reset}\n`)
          }
        }
      },
      result: (r) => {
        process.stdout.write('\n')
        if (dryRun) {
          process.stdout.write(`  ${C.yellow}--dry-run${C.reset}：${r.total} 个文件需要下载\n\n`)
          return 0
        }
        process.stdout.write(
          `  ${C.green}完成${C.reset} 下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length} · ` +
            `解压原生库 ${r.nativesExtracted} 个 · ${humanBytes(r.totalBytes)}\n`,
        )
        for (const f of r.failed.slice(0, 5)) {
          process.stdout.write(`  ${C.red}✗${C.reset} ${f.fileName}  ${C.dim}${f.error}${C.reset}\n`)
        }
        process.stdout.write('\n')
        return r.failed.length > 0 ? 2 : 0
      },
    },
    signal,
  )
}

async function runAssets(argv: readonly string[]): Promise<number> {
  const versionId = argv[0]
  if (versionId === undefined || versionId.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const layout = resolveLayout(root, 'default')
  const dryRun = argv.includes('--dry-run')
  const china = argv.includes('--china')
  const conc = argOf(argv, '--concurrency')
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}root${C.reset}  ${layout.root}\n\n`)

  const op = createAssetsSetup({
    layout,
    versionId,
    dryRun,
    sources: pickSources(china),
    mirror: china,
    ...(conc === undefined ? {} : { concurrency: Number(conc) }),
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}${C.reset}                    `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        if (ev.code === 'assets.tasks') {
          const t = ev.data as { keys: number; unique: number; totalBytes: number } | undefined
          if (t !== undefined) {
            process.stderr.write(
              `${C.dim}· index 里 ${t.keys} 个 key，去重后 ${t.unique} 个对象 · ${humanBytes(t.totalBytes)}${C.reset}\n`,
            )
          }
        } else if (ev.code === 'assets.failed') {
          const d = ev.data as { file?: string; error?: string } | undefined
          process.stderr.write(`\r${C.red}✗${C.reset} ${d?.file ?? ''}  ${d?.error ?? ''}\n`)
        }
      },
      result: (r) => {
        process.stdout.write('\n')
        if (dryRun) {
          process.stdout.write(`  ${C.yellow}--dry-run${C.reset}：${r.unique} 个对象需要下载\n\n`)
          return 0
        }
        process.stdout.write(
          `  ${C.green}完成${C.reset} 下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length} · ${humanBytes(r.totalBytes)}\n\n`,
        )
        return r.failed.length > 0 ? 2 : 0
      },
    },
    signal,
  )
}

async function runGame(argv: readonly string[]): Promise<number> {
  const versionId = argv[0]
  if (versionId === undefined || versionId.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const quiet = argv.includes('--quiet')
  const stopArg = argOf(argv, '--stop')
  const signal = createInterrupt().signal

  // 参数校验放在所有 I/O 之前：--memory 写错时不该先去探测 Java、解析版本，
  // 让用户等几秒才看到「其实是你参数写错了」
  const maxMemoryMiB = parseMemoryArg(argOf(argv, '--memory'))

  const javaPath = await pickJavaOrReport(versionId, layout, signal, argOf(argv, '--java'))
  if (javaPath === undefined) return 1

  const auth = await resolveAuth(argv, layout, signal)
  if (!auth.ok) return 1

  const offlineUsername = argOf(argv, '--user') ?? 'Player'
  // 有正版账号时名字来自账号，--user 不生效，别误报
  if (auth.account === undefined) warnOfflineUsername(offlineUsername)
  const planOp = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: offlineUsername,
    ...(auth.account === undefined ? {} : { account: auth.account }),
    ...(maxMemoryMiB === undefined ? {} : { maxMemoryMiB }),
    mirror: argv.includes('--china'),
  })

  let plan: LaunchPlan | undefined
  const planCode = await consume(
    planOp,
    {
      progress: () => {},
      log: () => {},
      result: (value) => {
        plan = value
        return 0
      },
    },
    signal,
  )
  if (planCode !== 0 || plan === undefined) return 1

  if (plan.missing.length > 0) {
    process.stderr.write(
      `\n${C.red}文件不齐${C.reset}：缺 ${plan.missing.length} 个\n` +
        `  ${C.dim}先跑：blockpilot setup ${versionId} --root ${root}${C.reset}\n\n`,
    )
    return 1
  }

  process.stdout.write('\n')
  process.stdout.write(`  ${C.green}启动${C.reset} ${plan.versionId} · 实例 ${layout.instanceId}\n`)
  process.stdout.write(`  ${C.dim}${plan.java}${C.reset}\n`)
  process.stdout.write(`  ${C.dim}日志实时输出，Ctrl+C 结束${C.reset}\n\n`)

  const op = createLauncher({
    plan,
    logsDir: join(layout.gameDir, 'logs'),
    ...(stopArg === undefined ? {} : { autoStopSeconds: Number(stopArg) }),
  })

  return consume(
    op,
    {
      progress: () => {},
      log: (ev) => {
        const data = ev.data as { line?: string; message?: string } | undefined
        if (ev.code === 'game.output' && data?.line !== undefined) {
          if (quiet && ev.level !== 'error') return
          process.stderr.write(
            ev.level === 'error' ? `${C.red}${data.line}${C.reset}\n` : `${C.dim}${data.line}${C.reset}\n`,
          )
        } else if (ev.code === 'launch.spawn_failed') {
          process.stderr.write(`${C.red}启动失败${C.reset}: ${data?.message ?? ''}\n`)
        } else if (ev.code === 'launch.autostop') {
          process.stderr.write(`\n${C.yellow}到达 --stop 时限，正在结束游戏${C.reset}\n`)
        }
      },
      result: (result) => {
        const secs = (result.durationMs / 1000).toFixed(1)
        process.stdout.write('\n')
        if (result.stopped) {
          process.stdout.write(`  ${C.green}已到时限结束${C.reset}  ${secs}s · ${result.lineCount} 行日志\n`)
          if (result.logPath !== undefined) {
            process.stdout.write(`  ${C.dim}日志${C.reset}  ${result.logPath}\n`)
          }
          process.stdout.write('\n')
          return 0
        }
        if (result.crashed) {
          process.stdout.write(
            `  ${C.red}异常退出${C.reset}  code=${result.exitCode ?? '-'} signal=${result.signal ?? '-'} · ${secs}s · ${result.lineCount} 行日志\n`,
          )
          if (result.logPath !== undefined) {
            process.stdout.write(`  ${C.dim}完整日志${C.reset}  ${result.logPath}\n`)
          }
          process.stdout.write('\n')
          process.stdout.write(`  ${C.bold}下一步${C.reset}\n`)
          process.stdout.write(`    blockpilot diag --root ${root} --instance ${instance}      ${C.dim}# 分析这份日志${C.reset}\n`)
          process.stdout.write(`    blockpilot preflight "${layout.gameDir}"   ${C.dim}# 扫描实例里的 mods${C.reset}\n\n`)
          return 2
        }

        process.stdout.write(`  ${C.green}正常退出${C.reset}  ${secs}s · ${result.lineCount} 行日志\n`)
        if (result.logPath !== undefined) {
          process.stdout.write(`  ${C.dim}日志${C.reset}  ${result.logPath}\n`)
        }
        process.stdout.write('\n')
        return 0
      },
    },
    signal,
  )
}

async function runFabric(argv: readonly string[]): Promise<number> {
  const gameVersion = argv[0]
  if (gameVersion === undefined || gameVersion.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const loader = argOf(argv, '--loader')
  const china = argv.includes('--china')
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}root${C.reset}  ${layout.root}\n`)
  process.stdout.write(`  ${C.dim}游戏版本${C.reset}  ${gameVersion}\n\n`)

  const op = createFabricSetup({
    layout,
    gameVersion,
    ...(loader === undefined ? {} : { loaderVersion: loader }),
    sources: pickSources(china),
    mirror: china,
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        const d = ev.data as { file?: string; source?: string; error?: string; id?: string } | undefined
        if (ev.code === 'fabric.profile' && d?.id !== undefined) {
          process.stderr.write(`${C.dim}· profile ${d.id}${C.reset}\n`)
        } else if (ev.code === 'fabric.ok' && d?.file !== undefined) {
          process.stderr.write(`\r${C.green}↓${C.reset} ${d.file}  ${C.dim}${d.source ?? ''}${C.reset}\n`)
        } else if (ev.code === 'fabric.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${d?.file ?? ''}  ${d?.error ?? ''}\n`)
        } else if (ev.code === 'fabric.no_hash') {
          const n = ev.data as { count: number; libs: string[] } | undefined
          process.stderr.write(
            `${C.yellow}!${C.reset} ${n?.count ?? 0} 个库拿不到 sha1，跳过不下载：${(n?.libs ?? []).join(', ')}\n`,
          )
        }
      },
      result: (r) => {
        process.stdout.write('\n')
        process.stdout.write(
          `  ${C.green}完成${C.reset} loader ${r.loaderVersion} · ${r.libraries} 个库 · ` +
            `下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length}\n`,
        )
        process.stdout.write(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
        process.stdout.write(`\n  ${C.bold}启动${C.reset}  blockpilot run ${r.versionId} --root ${root}\n\n`)
        return r.failed.length > 0 ? 2 : 0
      },
    },
    signal,
  )
}

async function runDeploy(argv: readonly string[]): Promise<number> {
  const packPath = argv[0]
  if (packPath === undefined || packPath.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const china = argv.includes('--china')
  const signal = createInterrupt().signal

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}整合包${C.reset}  ${packPath}\n`)
  process.stdout.write(`  ${C.dim}实例${C.reset}    ${instance} → ${layout.gameDir}\n\n`)

  // Forge 要跑 installer，得有 java。Fabric 用不到，但先检测一次省得后续分支判断。
  // 必须把包里的游戏版本传进去：26.2 要 Java 25，不知道版本就只能「捡最高的那个用」，
  // 机器上只有 Java 8 时也会被当成可用，Forge installer 随后炸得莫名其妙。
  let packGameVersion: string | undefined
  try {
    packGameVersion = readPackFile(packPath).instance.gameVersion
  } catch {
    // 包本身读不出来由 createDeploy 报 BAD_MODPACK，这里不抢它的活
  }
  const javaPath = await pickJavaOrReport(packGameVersion, layout, signal, argOf(argv, '--java'))

  const op = createDeploy({
    packPath,
    layout,
    sources: pickSources(china),
    mirror: china,
    ...(javaPath === undefined ? {} : { java: javaPath }),
    ...(proxyUrl === undefined ? {} : { proxy: proxyUrl }),
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
        const d = ev.data as
          | { step?: string; name?: string; file?: string; source?: string; error?: string }
          | undefined
        if (ev.code === 'deploy.pack' && d?.name !== undefined) {
          process.stderr.write(`${C.bold}${d.name}${C.reset}\n`)
        } else if (ev.code === 'deploy.step' && d?.step !== undefined) {
          const label =
            d.step === 'vanilla' ? '原版文件' : d.step === 'loader' ? '加载器' : d.step === 'files' ? '整合包文件' : 'overrides'
          process.stderr.write(`${C.cyan}→${C.reset} ${label}\n`)
        } else if (ev.code === 'deploy.ok' && d?.file !== undefined) {
          process.stderr.write(`  ${C.green}↓${C.reset} ${d.file}  ${C.dim}${d.source ?? ''}${C.reset}\n`)
        } else if (ev.code === 'deploy.failed') {
          process.stderr.write(`  ${C.red}✗${C.reset} ${d?.file ?? ''}  ${d?.error ?? ''}\n`)
        }
      },
      result: (r) => {
        process.stdout.write('\n')
        process.stdout.write(
          `  ${C.green}装好了${C.reset}  ${r.gameVersion} + ${r.loaderKind} ${r.loaderVersion}\n`,
        )
        process.stdout.write(
          `  ${C.dim}模组 ${r.mods} 个（文件 ${r.files} 个：下载 ${r.modsDownloaded} / 跳过 ${r.modsSkipped} / 失败 ${r.failed.length}）· overrides ${r.overrides} 个文件${C.reset}\n`,
        )

        // 部署后自检：装在完 ≠ 能跑
        process.stdout.write('\n')
        process.stdout.write(`  ${C.bold}部署后检查${C.reset}  ${VERDICT_TEXT[r.check.verdict]}\n`)
        const notable = r.check.findings.filter((f) => f.severity !== 'info')
        if (notable.length === 0) {
          process.stdout.write(`    ${C.dim}没有发现阻塞项${C.reset}\n`)
        } else {
          for (const f of notable) {
            process.stdout.write(`    ${SEVERITY_MARK[f.severity]} ${C.bold}${f.code}${C.reset}  ${f.message}\n`)
            if (f.hint !== undefined) process.stdout.write(`      ${C.dim}→ ${f.hint}${C.reset}\n`)
          }
        }

        process.stdout.write('\n')
        if (r.check.verdict === 'blocked') {
          process.stdout.write(`  ${C.yellow}先别启动${C.reset}，上面这些会直接导致崩溃\n\n`)
          return 2
        }
        process.stdout.write(`  ${C.bold}启动${C.reset}\n`)
        process.stdout.write(
          `    blockpilot run ${r.playableVersionId} --root ${root} --instance ${instance}\n\n`,
        )
        return r.failed.length > 0 ? 2 : 0
      },
      failed: (ev) => {
        process.stderr.write(`\n${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
      },
    },
    signal,
  )
}

function renderCulprits(r: DiagResult, certain: boolean): string[] {
  const lines: string[] = []
  const top = r.culprits.slice(0, 3)

  if (top.length === 0) {
    if (r.attributionNotes.length > 0) {
      lines.push(`${C.dim}定位不到具体模组${C.reset}`)
      for (const n of r.attributionNotes) lines.push(`  ${C.dim}${n}${C.reset}`)
      lines.push('')
    }
    return lines
  }

  lines.push(
    `${C.bold}${certain ? '指向的模组' : '可能与这些模组有关'}${C.reset}` +
      `${C.dim}（按证据强度排序${certain ? '，越靠前越可能是它' : '，仅供参考'}）${C.reset}`,
  )
  lines.push('')

  for (let i = 0; i < top.length; i += 1) {
    const c = top[i]
    if (c === undefined) continue
    const first = i === 0
    // 没有致命异常时不用红叉：红色在这里会被读成「就是它」
    const mark = first && certain ? `${C.red}✗${C.reset}` : `${C.yellow}?${C.reset}`
    const label = `${c.modId}${c.name === undefined ? '' : ` · ${c.name}`}${
      c.version === undefined ? '' : ` ${c.version}`
    }`

    lines.push(`  ${mark} ${first ? C.bold : ''}${label}${C.reset}`)
    lines.push(`    ${C.dim}${c.fileName} · ${c.frames} 个栈帧${C.reset}`)
    for (const reason of c.reasons.slice(0, 3)) {
      lines.push(`    ${C.dim}· ${reason}${C.reset}`)
    }
    lines.push(`    ${C.dim}${c.sampleFrame.slice(0, 130)}${C.reset}`)
    lines.push('')
  }

  if (top.length > 1) {
    lines.push(
      `  ${C.dim}一个崩溃现场往往牵涉多个模组。先处理第一个，剩下的常常会一起消失。${C.reset}`,
    )
    lines.push('')
  }

  return lines
}

function renderDiag(r: DiagResult): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot diag${C.reset}`)
  lines.push('')
  lines.push(`  ${C.dim}${r.logPath}${C.reset}  ${C.dim}${r.lineCount} 行${C.reset}`)
  lines.push('')

  if (r.verdict === 'clean') {
    lines.push(`  ${C.green}没有在日志里找到异常${C.reset}`)
    lines.push(`  ${C.dim}如果游戏确实崩了，可能日志没写全——看看进程是不是被外部杀掉${C.reset}`)
    lines.push('')
    return lines.join('\n')
  }

  // 有线索但没有致命异常：措辞必须留退路。
  // 这里最容易犯的错是「看起来像崩溃」就写成「崩在谁」，用户照着删错模组。
  if (r.verdict === 'inconclusive') {
    lines.push(`${C.bold}可疑记录${C.reset}${C.dim}（日志里没有致命异常）${C.reset}`)
    lines.push('')
    if (r.primary !== null) {
      lines.push(
        `  ${C.yellow}?${C.reset} ${C.bold}${r.primary.kind}${C.reset}  ${C.dim}第 ${r.primary.line} 行${C.reset}`,
      )
      lines.push(`    ${r.primary.message}`)
      lines.push(`    ${C.cyan}→ ${r.primary.hint}${C.reset}`)
      lines.push('')

      const after = r.lineCount - r.primary.line
      if (after > 0) {
        lines.push(`  ${C.dim}这条之后还有 ${after} 行日志。非致命告警在模组环境里很常见，`)
        lines.push(`  先确认游戏到底有没有崩，再决定要不要动模组。${C.reset}`)
        lines.push('')
      }
    }
    lines.push(...renderCulprits(r, false))

    if (r.primary !== null && r.primary.excerpt.length > 0) {
      lines.push(`  ${C.dim}现场（第 ${r.primary.line} 行附近）${C.reset}`)
      for (const l of r.primary.excerpt.slice(0, 6)) {
        lines.push(`    ${C.dim}${l.slice(0, 140)}${C.reset}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  const others = r.signals.filter((s) => s !== r.primary)

  if (r.primary !== null) {
    lines.push(`${C.bold}最可能的根因${C.reset}`)
    lines.push('')
    lines.push(
      `  ${C.red}✗${C.reset} ${C.bold}${r.primary.kind}${C.reset}  ${C.dim}第 ${r.primary.line} 行${C.reset}`,
    )
    lines.push(`    ${r.primary.message}`)
    lines.push(`    ${C.cyan}→ ${r.primary.hint}${C.reset}`)
    lines.push('')
  }

  if (others.length > 0) {
    lines.push(`${C.dim}其他线索（可能是连锁反应，别急着一个个修）${C.reset}`)
    lines.push('')
    for (const s of others) {
      lines.push(`  ${C.yellow}?${C.reset} ${s.kind}  ${C.dim}第 ${s.line} 行${C.reset}`)
      lines.push(`    ${C.dim}${s.hint}${C.reset}`)
    }
    lines.push('')
  }

  lines.push(...renderCulprits(r, true))

  if (r.primary !== null && r.primary.excerpt.length > 0) {
    lines.push(`  ${C.dim}现场（第 ${r.primary.line} 行附近）${C.reset}`)
    for (const l of r.primary.excerpt.slice(0, 6)) {
      lines.push(`    ${C.dim}${l.slice(0, 140)}${C.reset}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

async function runDiag(argv: readonly string[]): Promise<number> {
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)

  const explicit = argOf(argv, '--file')
  let logPath = explicit
  if (logPath === undefined) {
    const logs = listLogs(join(layout.gameDir, 'logs')).filter((l) => !l.native)
    const latest = logs[0]
    if (latest === undefined) {
      process.stderr.write(
        `${C.red}没有会话日志${C.reset}：${join(layout.gameDir, 'logs')}\n` +
          `${C.dim}先跑一次 blockpilot run${C.reset}\n`,
      )
      return 1
    }
    logPath = latest.path
  }

  const signal = createInterrupt().signal

  // --file 可能指向另一个实例的日志。日志默认在 `<实例>/logs/xxx.log`，
  // 所以优先用日志旁边那个 mods 目录，否则归属会串到当前实例上
  const siblingMods = join(dirname(dirname(logPath)), 'mods')
  const modsDir = existsSync(siblingMods) ? siblingMods : layout.mods

  const op = createDiagnose({ logPath, modsDir })
  const asJson = argv.includes('--json')
  return consume(
    op,
    {
      progress: () => {},
      log: () => {},
      result: (r) => {
        // 诊断结论是给机器读的最有价值的一份数据，MCP 那边一直是结构化的，
        // CLI 却只能拿到彩色文本——脚本还得正则解析，没道理
        if (asJson) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)
        else process.stdout.write(renderDiag(r))
        return r.verdict === 'crash' ? 2 : 0
      },
    },
    signal,
  )
}

async function runLogs(argv: readonly string[]): Promise<number> {
  const root = argOf(argv, '--root') ?? defaultRoot()
  const instance = argOf(argv, '--instance') ?? 'default'
  const layout = resolveLayout(root, instance)
  const logsDir = join(layout.gameDir, 'logs')
  const logs = listLogs(logsDir)

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}${logsDir}${C.reset}\n\n`)
  if (logs.length === 0) {
    process.stdout.write(`  ${C.dim}还没有日志。跑一次 run 就会产生。${C.reset}\n\n`)
    return 0
  }
  for (const l of logs) {
    const ago = Math.round((Date.now() - l.mtime) / 60000)
    const when = ago < 60 ? `${ago} 分钟前` : `${Math.round(ago / 60)} 小时前`
    const tag = l.native ? `${C.dim}[游戏原生]${C.reset} ` : ''
    process.stdout.write(`  ${tag}${l.name}  ${C.dim}${humanBytes(l.size)} · ${when}${C.reset}\n`)
  }
  process.stdout.write('\n')
  return 0
}

/** main() 解析出的代理 URL，子命令从这里读。CLI 是单命令进程，这样最简单 */
let proxyUrl: string | undefined

/** 全局的 `--proxy <url>`。放在子命令前后都行。 */
function takeProxyArg(argv: readonly string[]): string | undefined {
  const i = argv.indexOf('--proxy')
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (value === undefined) {
    process.stderr.write(`${C.red}--proxy 需要一个 URL，如 http://127.0.0.1:1081${C.reset}\n`)
    process.exit(1)
  }
  // 从 argv 里摘掉，免得子命令把它当成自己的参数。argv 是 slice(2) 的拷贝，可以直接改
  ;(argv as string[]).splice(i, 2)
  return value
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  // 代理要在任何 fetch 之前应用。取不到 --proxy 时也试环境变量
  try {
    const applied = applyProxy(takeProxyArg(argv))
    if (applied !== undefined) {
      proxyUrl = applied
      process.stderr.write(`${C.dim}· 走代理 ${applied}${C.reset}\n`)
    }
  } catch (err) {
    process.stderr.write(`${C.red}代理配置无效${C.reset}: ${String(err)}\n`)
    return 1
  }

  const cmd = argv[0]
  const allowed = cmd === undefined ? undefined : COMMAND_FLAGS[cmd]
  if (cmd !== undefined && allowed !== undefined) {
    // --proxy 是全局的，main 上面已经取过了；--help 任何命令都该能问
    const problem = validateFlags(argv.slice(1), { ...allowed, '--proxy': true, '--help': false })
    if (problem !== undefined) {
      process.stderr.write(`${C.red}${problem}${C.reset}\n`)
      process.stderr.write(`${C.dim}${cmd} 接受：${Object.keys(allowed).join(' ')}${C.reset}\n`)
      process.stderr.write(`${C.dim}完整用法：blockpilot --help${C.reset}\n`)
      return 1
    }
  }
  if (cmd === 'preflight') return runPreflight(argv.slice(1))
  if (cmd === 'install') return runInstall(argv.slice(1))
  if (cmd === 'java') return runJava(argv.slice(1))
  if (cmd === 'login') return runLogin(argv.slice(1))
  if (cmd === 'accounts') return runAccounts(argv.slice(1))
  if (cmd === 'setup') return runSetup(argv.slice(1))
  if (cmd === 'assets') return runAssets(argv.slice(1))
  if (cmd === 'fabric') return runFabric(argv.slice(1))
  if (cmd === 'deploy') return runDeploy(argv.slice(1))
  if (cmd === 'launch') return runLaunch(argv.slice(1))
  if (cmd === 'run') return runGame(argv.slice(1))
  if (cmd === 'logs') return runLogs(argv.slice(1))
  if (cmd === 'diag') return runDiag(argv.slice(1))
  usage()
  return cmd === undefined || cmd === '--help' ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    // 网络故障不该显示成「unexpected error」：它是最常见的一类失败，
    // 用户需要知道是哪个地址、以及可以怎么办。
    if (err instanceof LayoutError) {
      process.stderr.write(`${C.red}${err.message}${C.reset}\n`)
      process.exit(1)
    }
    if (err instanceof NetworkError) {
      process.stderr.write(`${C.red}网络错误${C.reset}：${err.message}\n`)
      process.stderr.write(
        `${C.dim}检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理${C.reset}\n`,
      )
      process.exit(1)
    }
    if (err instanceof VersionNotFoundError) {
      process.stderr.write(`${C.red}VERSION_NOT_FOUND${C.reset}: ${err.message}\n`)
      process.stderr.write(
        `${C.dim}先装一次：blockpilot deploy <整合包> 或 blockpilot setup <mc 版本>${C.reset}\n`,
      )
      process.exit(1)
    }
    if (err instanceof UsageError) {
      process.stderr.write(`${C.red}${err.code}${C.reset}: ${err.message}\n`)
      if (err.hint !== undefined) process.stderr.write(`${C.dim}${err.hint}${C.reset}\n`)
      process.exit(1)
    }
    process.stderr.write(`${C.red}unexpected error${C.reset}: ${String(err)}\n`)
    process.exit(1)
  },
)
