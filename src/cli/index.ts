#!/usr/bin/env node
import { join } from 'node:path'

import { createPreflight } from '../core/preflight/index.js'
import type { Finding, PreflightReport } from '../core/preflight/types.js'
import { createInstaller } from '../core/download/index.js'
import { chinaFirstSources, defaultSources } from '../core/download/sources.js'
import type { InstallResult } from '../core/download/types.js'
import { createJavaScan } from '../core/java/index.js'
import { createJavaInstall } from '../core/java/install.js'
import type { JavaInstallResult } from '../core/java/install.js'
import { detectJava } from '../core/java/detect.js'
import { pickJava, requiredJavaMajor } from '../core/java/types.js'
import type { JavaScanResult } from '../core/java/types.js'
import { createLaunchPlan } from '../core/launch/index.js'
import { createLauncher } from '../core/launch/run.js'
import { listLogs } from '../core/launch/logfile.js'
import { createDiagnose } from '../core/diagnostics/index.js'
import type { DiagResult } from '../core/diagnostics/index.js'
import type { RunResult } from '../core/launch/run.js'
import type { LaunchPlan } from '../core/launch/plan.js'
import { defaultRoot, resolveLayout } from '../core/layout.js'
import { createVanillaSetup, pickSources } from '../core/setup/vanilla.js'
import { createAssetsSetup } from '../core/setup/assets.js'
import { createFabricSetup } from '../core/setup/fabric.js'
import type { FabricSetupResult } from '../core/setup/fabric.js'
import { createDeploy } from '../core/deploy.js'
import type { DeployResult } from '../core/deploy.js'
import { detectHost } from '../core/host.js'
import { ModrinthSource } from '../sources/modrinth.js'

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  bold: '\u001b[1m',
}

const SEVERITY_MARK: Record<Finding['severity'], string> = {
  blocker: `${C.red}✗${C.reset}`,
  warning: `${C.yellow}!${C.reset}`,
  info: `${C.cyan}i${C.reset}`,
}

const VERDICT_TEXT: Record<PreflightReport['verdict'], string> = {
  ok: `${C.green}OK${C.reset}`,
  warn: `${C.yellow}WARN${C.reset}`,
  blocked: `${C.red}BLOCKED${C.reset}`,
  unknown: `${C.yellow}UNKNOWN${C.reset}`,
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
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
    lines.push(`  ${C.green}没有发现问题${C.reset}`)
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
      lines.push(
        `  ${C.green}+${C.reset} ${p.displayName}  ${C.dim}${p.fileName} · ${humanBytes(p.size)}${C.reset}`,
      )
      lines.push(`    ${C.dim}被 ${p.requiredBy.join('、')} 依赖 · ${p.projectId}/${p.versionId}${C.reset}`)
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
      lines.push(`  ${C.yellow}?${C.reset} ${m.projectId}  ${C.dim}${why}${C.reset}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function usage(): void {
  process.stdout.write(`BlockPilot — AI-drivable launcher core

  blockpilot preflight <target> [--json] [--no-host]
  blockpilot install   <target> --mods-dir <dir> [--dry-run] [--china]
  blockpilot java
  blockpilot setup  <version> [--root <dir>] [--instance <name>] [--china] [--dry-run]
  blockpilot assets <version> [--root <dir>] [--china] [--dry-run] [--concurrency <n>]
  blockpilot fabric <gameVersion> [--root <dir>] [--loader <ver>] [--china]
  blockpilot deploy <pack.mrpack> [--root <dir>] [--instance <name>] [--china]
  blockpilot launch <version> [--root <dir>] [--instance <name>] [--java <path>] [--memory <MB>] [--raw]
  blockpilot run    <version> [--root <dir>] [--instance <name>] [--memory <MB>] [--quiet] [--stop <秒>]

  <target>  .mrpack 文件，或实例目录
            （MultiMC/Prism 实例、裸 .minecraft、任何带 mods/ 的目录）

  install   先预检，再把 plan.installs 里的文件下载到 --mods-dir
            --dry-run 只打印计划，不下载
            --china   镜像优先（mcim 提到直连之前）
  preflight --json    输出结构化报告
            --no-host 跳过本机 Java / 内存检测（省 1–3 秒）
  java      列出本机可用的 Java 运行时
  java install <major> [--root <dir>]   从 Adoptium 下载并解压 JRE 到 <root>/java

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
  logs      列出会话日志
  diag      分析最近的会话日志，把异常归类成可理解的结论
            --file <path> 指定日志；默认取最新一份
            --quiet 只显示 ERROR 级日志
            --stop <秒> 到时自动结束（测试用）

`)
}

function argOf(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

async function runPreflight(argv: readonly string[]): Promise<number> {
  const target = argv[0]
  if (target === undefined || target.startsWith('--')) {
    usage()
    return 1
  }
  const asJson = argv.includes('--json')
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const host = argv.includes('--no-host') ? undefined : await detectHost()
  const op = createPreflight({
    target,
    source: new ModrinthSource(),
    ...(host === undefined ? {} : { host }),
  })

  for await (const ev of op.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        if (!asJson) {
          process.stderr.write(`\r${C.dim}${ev.label} ${ev.done}/${ev.total}${C.reset}   `)
          if (ev.done === ev.total) process.stderr.write('\r')
        }
        break
      case 'log':
        if (!asJson) process.stderr.write(`${C.dim}· ${ev.code}${C.reset}\n`)
        break
      case 'result': {
        const report = ev.value as PreflightReport
        if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
        else process.stdout.write(renderHuman(report))
        return report.verdict === 'blocked' ? 2 : 0
      }
      case 'failed':
        process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
        return 1
      default:
        break
    }
  }
  return 1
}

async function runInstall(argv: readonly string[]): Promise<number> {
  const target = argv[0]
  const modsDirArg = argOf(argv, '--mods-dir')
  if (target === undefined || target.startsWith('--') || modsDirArg === undefined) {
    usage()
    return 1
  }
  const dryRun = argv.includes('--dry-run')
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  process.stderr.write(`${C.dim}· preflight${C.reset}\n`)
  const host = argv.includes('--no-host') ? undefined : await detectHost()
  const preflight = createPreflight({
    target,
    source: new ModrinthSource(),
    ...(host === undefined ? {} : { host }),
  })
  let report: PreflightReport | undefined
  for await (const ev of preflight.run(controller.signal)) {
    if (ev.type === 'result') report = ev.value as PreflightReport
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      return 1
    }
  }
  if (report === undefined) return 1

  process.stdout.write(renderHuman(report))

  const installs = report.plan.installs
  if (installs.length === 0) {
    process.stdout.write(`${C.green}没有需要自动补装的东西。${C.reset}\n\n`)
    return report.verdict === 'blocked' ? 2 : 0
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
    plan: report.plan,
    modsDir,
    sources: argv.includes('--china') ? chinaFirstSources() : defaultSources(),
  })
  let result: InstallResult | undefined

  for await (const ev of installer.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}      `)
        if (ev.done === ev.total) process.stderr.write('\r')
        break
      case 'log': {
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
        break
      }
      case 'result':
        result = ev.value as InstallResult
        break
      default:
        break
    }
  }

  if (result === undefined) {
    process.stderr.write(`${C.red}安装没有返回结果${C.reset}\n`)
    return 1
  }

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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}安装 Java${C.reset} ${major} → ${join(layout.root, 'java')}\n\n`)

  const op = createJavaInstall({
    layout,
    major,
    sources: pickSources(argv.includes('--china')),
  })

  for await (const ev of op.run(controller.signal)) {
    if (ev.type === 'log') {
      const d = ev.data as { release?: string; size?: number; bytes?: number; files?: number } | undefined
      if (ev.code === 'java.download') {
        process.stderr.write(`${C.dim}· ${d?.release ?? ''} · ${humanBytes(d?.size ?? 0)}${C.reset}\n`)
      } else if (ev.code === 'java.extract') {
        process.stderr.write(`${C.dim}· 下载完成 ${humanBytes(d?.bytes ?? 0)}，解压中…${C.reset}\n`)
      }
    }
    if (ev.type === 'progress') {
      process.stderr.write(`\r${C.dim}${ev.done}/${ev.total}${C.reset}   `)
      if (ev.done === ev.total) process.stderr.write('\r')
    }
    if (ev.type === 'result') {
      const r = ev.value as JavaInstallResult
      process.stdout.write(
        `  ${C.green}${r.skipped ? '已存在' : '装好了'}${C.reset}  Java ${r.java.major} · ${r.java.version}\n`,
      )
      process.stdout.write(`  ${C.dim}${r.java.path}${C.reset}\n\n`)
      return 0
    }
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
      return 1
    }
  }
  return 1
}

async function runJava(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'install') return runJavaInstall(argv.slice(1))

  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const op = createJavaScan()
  for await (const ev of op.run(controller.signal)) {
    if (ev.type === 'result') {
      process.stdout.write(renderJava(ev.value as JavaScanResult))
      return 0
    }
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      return 1
    }
  }
  return 1
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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  let javaPath = argOf(argv, '--java')
  if (javaPath === undefined) {
    const need = requiredJavaMajor(versionId)
    const scan = await detectJava({
      signal: controller.signal,
      managedDir: join(layout.root, 'java'),
    })
    const picked = pickJava(scan.installs, need)
    if (picked === null) {
      process.stderr.write(
        `${C.red}没有找到 Java ${need}${C.reset}（本机：${scan.installs.map((j) => j.major).join(', ') || '无'}）\n`,
      )
      return 1
    }
    javaPath = picked.path
  }

  const memArg = argOf(argv, '--memory')
  const op = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: argOf(argv, '--user') ?? 'Player',
    ...(memArg === undefined ? {} : { maxMemoryMiB: Number(memArg) }),
    mirror: argv.includes('--china'),
  })

  for await (const ev of op.run(controller.signal)) {
    if (ev.type === 'log') process.stderr.write(`${C.dim}· ${ev.code}${C.reset}\n`)
    if (ev.type === 'result') {
      process.stdout.write(renderLaunch(ev.value as LaunchPlan, raw))
      return 0
    }
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      return 1
    }
  }
  return 1
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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

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

  for await (const ev of op.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
        break
      case 'log': {
        const data = ev.data as { file?: string; source?: string; error?: string } | undefined
        if (ev.code === 'setup.ok' && data?.file !== undefined) {
          process.stderr.write(`\r${C.green}↓${C.reset} ${data.file}  ${C.dim}${data.source ?? ''}${C.reset}\n`)
        } else if (ev.code === 'setup.cached' && data?.file !== undefined) {
          process.stderr.write(`\r${C.cyan}=${C.reset} ${data.file}\n`)
        } else if (ev.code === 'setup.failed') {
          process.stderr.write(`\r${C.red}✗${C.reset} ${data?.file ?? ''}  ${data?.error ?? ''}\n`)
        } else if (ev.code === 'setup.tasks' ) {
          const t = ev.data as { tasks: number; totalBytes: number } | undefined
          if (t !== undefined) {
            process.stderr.write(`${C.dim}· ${t.tasks} 个文件 · ${humanBytes(t.totalBytes)}${C.reset}\n`)
          }
        }
        break
      }
      case 'result': {
        const r = ev.value as {
          total: number
          downloaded: number
          skipped: number
          failed: readonly { fileName: string; error: string }[]
          nativesExtracted: number
          totalBytes: number
        }
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
      }
      case 'failed':
        process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        return 1
      default:
        break
    }
  }
  return 1
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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

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

  for await (const ev of op.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}${C.reset}                    `)
        if (ev.done === ev.total) process.stderr.write('\r')
        break
      case 'log': {
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
        break
      }
      case 'result': {
        const r = ev.value as {
          total: number
          unique: number
          downloaded: number
          skipped: number
          failed: readonly unknown[]
          totalBytes: number
        }
        process.stdout.write('\n')
        if (dryRun) {
          process.stdout.write(`  ${C.yellow}--dry-run${C.reset}：${r.unique} 个对象需要下载\n\n`)
          return 0
        }
        process.stdout.write(
          `  ${C.green}完成${C.reset} 下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length} · ${humanBytes(r.totalBytes)}\n\n`,
        )
        return r.failed.length > 0 ? 2 : 0
      }
      case 'failed':
        process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        return 1
      default:
        break
    }
  }
  return 1
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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  let javaPath = argOf(argv, '--java')
  if (javaPath === undefined) {
    const need = requiredJavaMajor(versionId)
    const scan = await detectJava({
      signal: controller.signal,
      managedDir: join(layout.root, 'java'),
    })
    const picked = pickJava(scan.installs, need)
    if (picked === null) {
      process.stderr.write(
        `${C.red}没有找到 Java ${need}${C.reset}（本机：${scan.installs.map((j) => j.major).join(', ') || '无'}）\n`,
      )
      return 1
    }
    javaPath = picked.path
  }

  const memArg = argOf(argv, '--memory')
  const planOp = createLaunchPlan({
    versionId,
    layout,
    java: javaPath,
    username: argOf(argv, '--user') ?? 'Player',
    ...(memArg === undefined ? {} : { maxMemoryMiB: Number(memArg) }),
    mirror: argv.includes('--china'),
  })

  let plan: LaunchPlan | undefined
  for await (const ev of planOp.run(controller.signal)) {
    if (ev.type === 'result') plan = ev.value as LaunchPlan
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      return 1
    }
  }
  if (plan === undefined) return 1

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

  let result: RunResult | undefined
  for await (const ev of op.run(controller.signal)) {
    if (ev.type === 'log') {
      const data = ev.data as { line?: string; message?: string } | undefined
      if (ev.code === 'game.output' && data?.line !== undefined) {
        if (quiet && ev.level !== 'error') continue
        process.stderr.write(
          ev.level === 'error' ? `${C.red}${data.line}${C.reset}\n` : `${C.dim}${data.line}${C.reset}\n`,
        )
      } else if (ev.code === 'launch.spawn_failed') {
        process.stderr.write(`${C.red}启动失败${C.reset}: ${data?.message ?? ''}\n`)
      } else if (ev.code === 'launch.autostop') {
        process.stderr.write(`\n${C.yellow}到达 --stop 时限，正在结束游戏${C.reset}\n`)
      }
    }
    if (ev.type === 'result') result = ev.value as RunResult
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      return 1
    }
  }

  if (result === undefined) {
    process.stderr.write(`${C.red}没有拿到运行结果${C.reset}\n`)
    return 1
  }

  const secs = (result.durationMs / 1000).toFixed(1)
  process.stdout.write('\n')
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
}

async function runFabric(argv: readonly string[]): Promise<number> {
  const gameVersion = argv[0]
  if (gameVersion === undefined || gameVersion.startsWith('--')) {
    usage()
    return 1
  }
  const root = argOf(argv, '--root') ?? defaultRoot()
  const layout = resolveLayout(root, 'default')
  const loader = argOf(argv, '--loader')
  const china = argv.includes('--china')
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}root${C.reset}  ${layout.root}\n`)
  process.stdout.write(`  ${C.dim}游戏版本${C.reset}  ${gameVersion}\n\n`)

  const op = createFabricSetup({
    layout,
    gameVersion,
    ...(loader === undefined ? {} : { loaderVersion: loader }),
    sources: pickSources(china),
  })

  for await (const ev of op.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        process.stderr.write(`\r${C.dim}下载 ${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
        break
      case 'log': {
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
        break
      }
      case 'result': {
        const r = ev.value as FabricSetupResult
        process.stdout.write('\n')
        process.stdout.write(
          `  ${C.green}完成${C.reset} loader ${r.loaderVersion} · ${r.libraries} 个库 · ` +
            `下载 ${r.downloaded} · 跳过 ${r.skipped} · 失败 ${r.failed.length}\n`,
        )
        process.stdout.write(`  ${C.dim}版本 JSON${C.reset}  ${r.versionJsonPath}\n`)
        process.stdout.write(`\n  ${C.bold}启动${C.reset}  blockpilot run ${r.versionId} --root ${root}\n\n`)
        return r.failed.length > 0 ? 2 : 0
      }
      case 'failed':
        process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        return 1
      default:
        break
    }
  }
  return 1
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
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  process.stdout.write('\n')
  process.stdout.write(`  ${C.dim}整合包${C.reset}  ${packPath}\n`)
  process.stdout.write(`  ${C.dim}实例${C.reset}    ${instance} → ${layout.gameDir}\n\n`)

  // Forge 要跑 installer，得有 java。Fabric 用不到，但先检测一次省得后续分支判断
  let javaPath = argOf(argv, '--java')
  if (javaPath === undefined) {
    const scan = await detectJava({
      signal: controller.signal,
      managedDir: join(layout.root, 'java'),
    })
    javaPath = [...scan.installs].sort((a, b) => b.major - a.major)[0]?.path
  }

  const op = createDeploy({
    packPath,
    layout,
    sources: pickSources(china),
    ...(javaPath === undefined ? {} : { java: javaPath }),
  })

  for await (const ev of op.run(controller.signal)) {
    switch (ev.type) {
      case 'progress':
        process.stderr.write(`\r${C.dim}${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
        break
      case 'log': {
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
        break
      }
      case 'result': {
        const r = ev.value as DeployResult
        process.stdout.write('\n')
        process.stdout.write(
          `  ${C.green}装好了${C.reset}  ${r.gameVersion} + ${r.loaderKind} ${r.loaderVersion}\n`,
        )
        process.stdout.write(
          `  ${C.dim}模组 ${r.mods} 个（下载 ${r.modsDownloaded} / 跳过 ${r.modsSkipped} 失败 ${r.failed.length}）· overrides ${r.overrides} 个文件${C.reset}\n`,
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
      }
      case 'failed':
        process.stderr.write(`\n${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
        return 1
      default:
        break
    }
  }
  return 1
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

  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const op = createDiagnose({ logPath })
  for await (const ev of op.run(controller.signal)) {
    if (ev.type === 'result') {
      const r = ev.value as DiagResult
      process.stdout.write(renderDiag(r))
      return r.verdict === 'crash' ? 2 : 0
    }
    if (ev.type === 'failed') {
      process.stderr.write(`${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
      return 1
    }
  }
  return 1
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

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (cmd === 'preflight') return runPreflight(argv.slice(1))
  if (cmd === 'install') return runInstall(argv.slice(1))
  if (cmd === 'java') return runJava(argv.slice(1))
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
    process.stderr.write(`${C.red}unexpected error${C.reset}: ${String(err)}\n`)
    process.exit(1)
  },
)
