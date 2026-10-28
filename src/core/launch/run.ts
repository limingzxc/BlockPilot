import { spawn } from 'node:child_process'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { AsyncQueue } from '../download/queue.js'
import { openLogFile } from './logfile.js'
import type { LaunchPlan } from './plan.js'

export interface RunOptions {
  readonly plan: LaunchPlan
  /** 会话日志目录。不给就不落盘 */
  readonly logsDir?: string
  /** 测试用：N 秒后强制结束 */
  readonly autoStopSeconds?: number
}

export interface RunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** 到 `--stop` 时限由我们结束的。此时不算崩溃 */
  readonly stopped: boolean
  /** 非 0 退出，或者被信号杀死（不含我们主动结束的情况） */
  readonly crashed: boolean
  /** 最后 N 行输出，用于崩溃现场 */
  readonly tail: readonly string[]
  readonly lineCount: number
  /** 会话日志的落地路径。没开日志时为空 */
  readonly logPath?: string
}

const TAIL_SIZE = 40

/** 跨 chunk 拼行：一行可能被切成两段，不能按 chunk 直接切。 */
function makeSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = ''
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line !== '') onLine(line)
    }
  }
}

function looksLikeError(line: string): boolean {
  return /\b(ERROR|FATAL|Exception|Caused by)\b/.test(line)
}

export function createLauncher(opts: RunOptions): Operation<RunResult> {
  return defineOperation<RunResult>('launch', async function* (signal) {
    const { plan } = opts
    yield Op.log('info', 'launch.spawn', {
      java: plan.java,
      mainClass: plan.mainClass,
      cwd: plan.cwd,
      args: plan.args.length,
    })

    // stdin 设成 ignore：没有 TUI，留着会占一个 fd
    const child = spawn(plan.java, [...plan.args], {
      cwd: plan.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    })

    const started = Date.now()
    const queue = new AsyncQueue<OpEvent<never>>()
    const sink =
      opts.logsDir === undefined ? null : openLogFile(opts.logsDir, plan.versionId)
    if (sink !== null) {
      yield Op.log('info', 'launch.logfile', { path: sink.path })
    }
    const tail: string[] = []
    let lineCount = 0

    const onLine = (stream: 'stdout' | 'stderr') => (line: string) => {
      lineCount += 1
      tail.push(line)
      if (tail.length > TAIL_SIZE) tail.shift()
      sink?.write(line)
      queue.push(
        Op.log(looksLikeError(line) ? 'error' : 'info', 'game.output', { stream, line }),
      )
    }

    child.stdout.on('data', makeSplitter(onLine('stdout')))
    child.stderr.on('data', makeSplitter(onLine('stderr')))

    let timer: NodeJS.Timeout | undefined
    /** 是我们自己按 --stop 结束的：不能既当裁判又吹哨，把主动结束报成崩溃 */
    let stopped = false
    if (opts.autoStopSeconds !== undefined) {
      timer = setTimeout(() => {
        stopped = true
        queue.push(Op.log('warn', 'launch.autostop', { seconds: opts.autoStopSeconds }))
        child.kill()
      }, opts.autoStopSeconds * 1000)
    }

    const abortHandler = () => {
      queue.push(Op.log('warn', 'launch.aborted'))
      child.kill()
    }
    signal.addEventListener('abort', abortHandler, { once: true })

    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (err) => {
        queue.push(Op.log('error', 'launch.spawn_failed', { message: err.message }))
        resolve({ code: null, sig: null })
      })
      child.on('exit', (code, sig) => resolve({ code, sig }))
    })

    const finish = exited.then((r) => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', abortHandler)
      queue.close()
      return r
    })

    for await (const ev of queue.drain()) yield ev
    const { code, sig } = await finish

    const durationMs = Date.now() - started
    const crashed = !stopped && (code !== 0 || sig !== null)

    if (crashed) {
      yield Op.log('error', 'launch.exited_abnormally', { code, signal: sig, durationMs })
    } else {
      yield Op.log('info', 'launch.exited', { code, durationMs })
    }

    if (sink !== null) await sink.close()

    yield Op.result({
      exitCode: code,
      signal: sig,
      durationMs,
      stopped,
      crashed,
      tail,
      lineCount,
      ...(sink === null ? {} : { logPath: sink.path }),
    })
    yield Op.done()
  })
}
