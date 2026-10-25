import { spawn } from 'node:child_process'

import { Op } from '../events.js'
import type { OpEvent } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { AsyncQueue } from '../download/queue.js'
import type { LaunchPlan } from './plan.js'

export interface RunOptions {
  readonly plan: LaunchPlan
  /** 测试用：N 秒后强制结束 */
  readonly autoStopSeconds?: number
}

export interface RunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** 非 0 退出，或者被信号杀死 */
  readonly crashed: boolean
  /** 最后 N 行输出，用于崩溃现场 */
  readonly tail: readonly string[]
  readonly lineCount: number
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
    const tail: string[] = []
    let lineCount = 0

    const onLine = (stream: 'stdout' | 'stderr') => (line: string) => {
      lineCount += 1
      tail.push(line)
      if (tail.length > TAIL_SIZE) tail.shift()
      queue.push(
        Op.log(looksLikeError(line) ? 'error' : 'info', 'game.output', { stream, line }),
      )
    }

    child.stdout.on('data', makeSplitter(onLine('stdout')))
    child.stderr.on('data', makeSplitter(onLine('stderr')))

    let timer: NodeJS.Timeout | undefined
    if (opts.autoStopSeconds !== undefined) {
      timer = setTimeout(() => {
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
    const crashed = code !== 0 || sig !== null

    if (crashed) {
      yield Op.log('error', 'launch.exited_abnormally', { code, signal: sig, durationMs })
    } else {
      yield Op.log('info', 'launch.exited', { code, durationMs })
    }

    yield Op.result({ exitCode: code, signal: sig, durationMs, crashed, tail, lineCount })
    yield Op.done()
  })
}
