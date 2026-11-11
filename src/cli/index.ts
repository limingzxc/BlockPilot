#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BlockPilotError } from '../core/errors.js'
import { NetworkError } from '../core/http.js'
import { LayoutError } from '../core/layout.js'
import { applyProxy } from '../core/proxy.js'
import { VersionNotFoundError } from '../core/version/fetch.js'
import { cmdAccounts } from './commands/accounts.js'
import { cmdAssets } from './commands/assets.js'
import { cmdConfig } from './commands/config.js'
import { cmdDeploy } from './commands/deploy.js'
import { cmdDiag } from './commands/diag.js'
import { cmdFabric } from './commands/fabric.js'
import { cmdForge, cmdNeoforge } from './commands/forge.js'
import { cmdInstall } from './commands/install.js'
import { cmdJava } from './commands/java.js'
import { cmdLaunch } from './commands/launch.js'
import { cmdLogin } from './commands/login.js'
import { cmdLogs } from './commands/logs.js'
import { cmdPreflight } from './commands/preflight.js'
import { cmdQuilt } from './commands/quilt.js'
import { cmdRun } from './commands/run.js'
import { cmdSetup } from './commands/setup.js'
import { cmdUpdate } from './commands/update.js'
import { cmdVerify } from './commands/verify.js'
import type { Command } from './commands.js'
import { createContext, usageText } from './commands.js'
import { validateFlags } from './flags.js'
import { UsageError } from './shared.js'
import {
  C,
  createInterrupt,
  emitExit,
  emitFailed,
  isEventStream,
  say,
  setEventStream,
} from './ui.js'

function usage(): void {
  say(`${usageText(COMMANDS)}\n`)
}

/** 全部子命令。声明在 handlers 之后，`run` 引用的是提升的函数声明。 */
export const COMMANDS: readonly Command[] = [
  cmdPreflight,
  cmdInstall,
  cmdJava,
  cmdLogin,
  cmdAccounts,
  cmdSetup,
  cmdAssets,
  cmdFabric,
  cmdQuilt,
  cmdForge,
  cmdNeoforge,
  cmdDeploy,
  cmdVerify,
  cmdUpdate,
  cmdConfig,
  cmdLaunch,
  cmdRun,
  cmdLogs,
  cmdDiag,
]

/**
 * 全局的 `--proxy <url>`。放在子命令前后都行。
 *
 * 从 argv 里摘掉，免得子命令把它当成自己的参数。argv 是 `process.argv.slice(2)`
 * 的拷贝，可以直接改。少写值时抛 UsageError，让 main 的错误映射统一处理——
 * 以前这里直接 `process.exit(1)`，绕过了那段映射。
 */
function takeProxyArg(argv: string[]): string | undefined {
  const i = argv.indexOf('--proxy')
  if (i === -1) return undefined
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError('BAD_PROXY', '--proxy 需要一个 URL', '例：--proxy http://127.0.0.1:1081')
  }
  argv.splice(i, 2)
  return value
}

/**
 * `--events` 是全局开关，不属于任何子命令。
 *
 * 在命令分发前摘掉：否则 `validateFlags` 会把它当成未知参数。
 * 只认 `--events` 与 `--events=ndjson`；别的值留给未知参数报错。
 */
function takeEventFlag(argv: string[]): void {
  for (let i = argv.length - 1; i >= 0; i -= 1) {
    if (argv[i] === '--events' || argv[i] === '--events=ndjson') {
      argv.splice(i, 1)
      setEventStream(true)
    }
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  takeEventFlag(argv)
  // 代理要在任何 fetch 之前应用。取不到 --proxy 时也试环境变量
  const proxyArg = takeProxyArg(argv)
  let proxy: string | undefined
  try {
    proxy = applyProxy(proxyArg)
  } catch (err) {
    process.stderr.write(`${C.red}代理配置无效${C.reset}: ${String(err)}\n`)
    return 1
  }
  if (proxy !== undefined) process.stderr.write(`${C.dim}· 走代理 ${proxy}${C.reset}\n`)

  const name = argv[0]
  if (name === undefined || name === '--help' || name === '-h') {
    usage()
    return 0
  }

  const command = COMMANDS.find((c) => c.name === name)
  if (command === undefined) {
    emitFailed('UNKNOWN_COMMAND', `未知命令 ${name}`)
    process.stderr.write(`${C.red}未知命令${C.reset} ${name}\n`)
    usage()
    return 1
  }

  const args = argv.slice(1)
  // `--help` 任何命令都该能问，且不参与位置参数校验
  if (args.includes('--help') || args.includes('-h')) {
    usage()
    return 0
  }

  const problem = validateFlags(args, command.flags)
  if (problem !== undefined) {
    emitFailed('BAD_ARGS', problem)
    process.stderr.write(`${C.red}${problem}${C.reset}\n`)
    process.stderr.write(
      `${C.dim}${name} 接受：${Object.keys(command.flags).join(' ')}${C.reset}\n`,
    )
    process.stderr.write(`${C.dim}完整用法：blockpilot --help${C.reset}\n`)
    return 1
  }

  return command.run(
    createContext({
      argv: args,
      flags: command.flags,
      signal: createInterrupt().signal,
      usage,
      ...(proxy === undefined ? {} : { proxy }),
    }),
  )
}

/**
 * 顶层错误 → 人话 + 退出码。
 *
 * 网络故障不该显示成「unexpected error」：它是最常见的一类失败，
 * 用户需要知道是哪个地址、以及可以怎么办。
 */
function reportFatal(err: unknown): void {
  // 事件流消费者也要看到终止原因：以前这里只写 stderr，stdout 停在半截事件上
  if (isEventStream()) {
    const code =
      err instanceof BlockPilotError
        ? err.code
        : err instanceof VersionNotFoundError
          ? 'VERSION_NOT_FOUND'
          : err instanceof NetworkError
            ? 'NETWORK_ERROR'
            : 'UNEXPECTED'
    const message = err instanceof Error ? err.message : String(err)
    emitFailed(code, message, err instanceof BlockPilotError ? err.hint : undefined)
    emitExit(1)
  }
  if (err instanceof LayoutError) {
    process.stderr.write(`${C.red}${err.message}${C.reset}\n`)
    process.exitCode = 1
    return
  }
  if (err instanceof NetworkError) {
    process.stderr.write(`${C.red}网络错误${C.reset}：${err.message}\n`)
    // Java 的二进制挂在 GitHub Releases 上，`--china` 的镜像表覆盖不到它。
    // 这时候还说「加 --china 试试」等于让用户白试一次（issue #6）。
    if (/github\.com|adoptium/i.test(err.url)) {
      process.stderr.write(
        `${C.dim}Java 的二进制在 GitHub Releases 上。可试：${C.reset}\n` +
          `${C.dim}  1) 加 --china（走清华 TUNA 镜像，只覆盖镜像里已有的构建）${C.reset}\n` +
          `${C.dim}  2) --proxy http://127.0.0.1:<port> 走代理${C.reset}\n` +
          `${C.dim}  3) 自己下 Temurin 压缩包，解压到 <root>/java（顶层要能看到 bin/java）${C.reset}\n` +
          `${C.dim}  4) 用系统已装的 Java：--java <路径>${C.reset}\n`,
      )
    } else {
      process.stderr.write(
        `${C.dim}检查网络；国内可加 --china 走镜像，或用 --proxy 指定代理${C.reset}\n`,
      )
    }
    process.exitCode = 1
    return
  }
  if (err instanceof VersionNotFoundError) {
    process.stderr.write(`${C.red}VERSION_NOT_FOUND${C.reset}: ${err.message}\n`)
    process.stderr.write(
      `${C.dim}先装一次：blockpilot deploy <整合包> 或 blockpilot setup <mc 版本>${C.reset}\n`,
    )
    process.exitCode = 1
    return
  }
  if (err instanceof BlockPilotError) {
    process.stderr.write(`${C.red}${err.code}${C.reset}: ${err.message}\n`)
    if (err.hint !== undefined) process.stderr.write(`${C.dim}${err.hint}${C.reset}\n`)
    process.exitCode = 1
    return
  }
  process.stderr.write(`${C.red}unexpected error${C.reset}: ${String(err)}\n`)
  process.exitCode = 1
}

/**
 * 判断当前模块是不是入口。
 *
 * `hints.test.ts` 要 import 这个文件取 `COMMANDS`（提示里的命令必须真的能敲），
 * 无条件的 `main()` 会让那次 import 变成一次真实的命令行执行。
 *
 * 不能用 `import.meta.url === pathToFileURL(process.argv[1]).href`：npm link /
 * 全局安装时 bin 是符号链接，argv[1] 是链接路径，而 ESM 的 import.meta.url
 * 已经是 realpath，比较永远不相等，CLI 会静默退出 0。两边都取 realpath。
 */
export function isEntryPoint(entry: string | undefined): boolean {
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1])) {
  main().then((code) => {
    // 有些命令在进入 Operation 前就返回（缺位置参数、未知 flag）：
    // 兜底保证事件流最后一行永远是 exit
    if (isEventStream()) emitExit(code)
    // 不用 process.exit：管道里的 --json 大输出可能还没 flush 完就被截断
    process.exitCode = code
  }, reportFatal)
}
