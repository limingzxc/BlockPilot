/**
 * CLI 主流程：全局参数、命令分发、致命错误映射。
 *
 * 入口守卫在 index.ts；这里不关心「自己是不是入口」，因此可以被测试 import。
 */
import { BlockPilotError } from '../core/errors.js'
import { NetworkError } from '../core/http.js'
import { LayoutError } from '../core/layout.js'
import { applyProxy } from '../core/proxy.js'
import { VersionNotFoundError } from '../core/version/fetch.js'
import { createContext } from './command/context.js'
import { validateFlags } from './command/flags.js'
import { usageText } from './command/usage.js'
import { createInterrupt } from './consume/index.js'
import { C } from './output/ansi.js'
import { emitExit, emitFailed, isEventStream, say, setEventStream } from './output/stream.js'
import { COMMANDS } from './registry.js'
import { UsageError } from './shared/errors.js'

function usage(): void {
  say(`${usageText(COMMANDS)}\n`)
}

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

export async function main(): Promise<number> {
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
export function reportFatal(err: unknown): void {
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
