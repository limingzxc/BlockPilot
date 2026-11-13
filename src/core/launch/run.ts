import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AsyncQueue } from '../download/queue.js'
import type { OpEvent } from '../events/index.js'
import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import { redactSecrets } from '../redact.js'
import { openLogFile } from './logfile.js'
import type { LaunchPlan } from './plan.js'

export interface RunOptions {
  readonly plan: LaunchPlan
  /** 会话日志目录。不给就不落盘 */
  readonly logsDir?: string
  /** 测试用：N 秒后强制结束 */
  readonly autoStopSeconds?: number
  /** 测试用：把「日志安静多久算死」调短，不用等 20 秒 */
  readonly heartbeatGraceMs?: number
}

export interface RunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** 由我们主动结束的（`--stop` 到点或 Ctrl+C）。此时不算崩溃 */
  readonly stopped: boolean
  /** 其中是 Ctrl+C 打断的。文案要说「已中断」而不是「已到时限」 */
  readonly aborted: boolean
  /** 非 0 退出，或者被信号杀死（不含我们主动结束的情况） */
  readonly crashed: boolean
  /** 进程活着但日志早就断了：游戏中途死掉，进程没退 */
  readonly diedBeforeStop: boolean
  /** 最后 N 行输出，用于崩溃现场 */
  readonly tail: readonly string[]
  readonly lineCount: number
  /** 会话日志的落地路径。没开日志时为空 */
  readonly logPath?: string
}

const TAIL_SIZE = 40

/**
 * 「进程还活着」不等于「游戏还活着」。
 *
 * 未捕获异常打在渲染线程上时，JVM 不一定退出——尤其在标题画面崩溃时，
 * 用户看到的是一个卡死的窗口，而 `--stop` 到点我们照样 exit 0（issue #2）。
 * 判据用日志心跳：最后一行已经安静了很久，且日志以栈帧收尾。
 */
const HEARTBEAT_GRACE_MS = 20_000

function endsWithStack(tail: readonly string[]): boolean {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = (tail[i] ?? '').trim()
    if (line === '') continue
    if (/^at\s|^Caused by:|^Suppressed:|^\.\.\. \d+ more/.test(line)) return true
    // 异常头本身也可能就是最后一行（栈被截断时）
    return /\b(Exception|Error)\b/.test(line)
  }
  return false
}

interface Splitter {
  (chunk: Buffer): void
  /** 进程关闭时把最后一行没有换行符的残留也交出去 */
  flush(): void
}

/** 跨 chunk 拼行：一行可能被切成两段，不能按 chunk 直接切。 */
function makeSplitter(onLine: (line: string) => void): Splitter {
  let buffer = ''
  const push = (chunk: Buffer): void => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line !== '') onLine(line)
    }
  }
  return Object.assign(push, {
    flush: (): void => {
      if (buffer !== '') {
        onLine(buffer)
        buffer = ''
      }
    },
  })
}

function looksLikeError(line: string): boolean {
  return /\b(ERROR|FATAL|Exception|Caused by)\b/.test(line)
}

/**
 * ENOENT 有两种完全不同的原因，混在一句话里就会把人带偏：
 * 路径不存在（去装 Java），或者路径在但不可执行（权限/架构）。
 */
function spawnErrorMessage(java: string, err: Error & { code?: string }): string {
  if (err.code !== 'ENOENT') return err.message
  const isPath = java.includes('/') || java.includes('\\')
  if (!isPath)
    return `PATH 里找不到可执行的 java（${java}）。用 --java 指定，或跑 blockpilot java install`
  return existsSync(java)
    ? `${java} 存在但无法执行。检查文件权限与架构（32/64 位）`
    : `找不到 Java：${java}。跑 blockpilot java install <major>，或用 --java 指定`
}

export function createLauncher(opts: RunOptions): Operation<RunResult> {
  return defineOperation<RunResult>('launch', async function* (signal) {
    const { plan } = opts

    /**
     * 先确认 cwd 在，否则 spawn 报的是 `ENOENT: java.exe`——
     * 用户会去查 Java，而真正的问题是 `--root` 指错了地方（issue #9）。
     * 这里不替用户 mkdir：悄悄建一个空目录会把「路径写错」变成「模组全没了」。
     */
    if (!existsSync(plan.cwd)) {
      yield Op.failed(
        'INSTANCE_DIR_MISSING',
        `实例目录不存在：${plan.cwd}`,
        '先跑 blockpilot setup <版本 id> --root <root> 生成实例，或检查 --root/--instance 是否指对了',
      )
      return
    }

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
    const sink = opts.logsDir === undefined ? null : openLogFile(opts.logsDir, plan.versionId)
    if (sink !== null) {
      yield Op.log('info', 'launch.logfile', { path: sink.path })
    }
    const tail: string[] = []
    let lineCount = 0
    /** 最后一行日志的时间。用它判断「进程活着但游戏已经死了」 */
    let lastLineAt = Date.now()

    const onLine = (stream: 'stdout' | 'stderr') => (raw: string) => {
      // 1.6.x 会把 `Session ID is token:<token>:<uuid>` 打在 stdout。
      // 日志会落盘、被 diag/MCP 读给 AI，所以在**进入 tail/日志/事件之前**脱敏，
      // 而不是在某个渲染器里各自擦一遍（ADR-0040）。
      const line = redactSecrets(raw)
      lineCount += 1
      lastLineAt = Date.now()
      tail.push(line)
      if (tail.length > TAIL_SIZE) tail.shift()
      sink?.write(line)
      queue.push(Op.log(looksLikeError(line) ? 'error' : 'info', 'game.output', { stream, line }))
    }

    const stdoutSplitter = makeSplitter(onLine('stdout'))
    const stderrSplitter = makeSplitter(onLine('stderr'))
    child.stdout.on('data', stdoutSplitter)
    child.stderr.on('data', stderrSplitter)

    let timer: NodeJS.Timeout | undefined
    /** 是我们自己按 --stop 结束的：不能既当裁判又吹哨，把主动结束报成崩溃 */
    let stopped = false
    /** Ctrl+C 打断：同样不算崩溃，但文案要和「到点结束」区分 */
    let aborted = false
    const autoStopSeconds = opts.autoStopSeconds
    if (autoStopSeconds !== undefined) {
      timer = setTimeout(() => {
        stopped = true
        queue.push(Op.log('warn', 'launch.autostop', { seconds: autoStopSeconds }))
        child.kill()
      }, autoStopSeconds * 1000)
    }

    const abortHandler = () => {
      // 不标记 stopped 的话，child.kill() 会让下面算出 crashed=true：
      // 用户按 Ctrl+C，最后却看到「异常退出」并建议 diag
      aborted = true
      stopped = true
      queue.push(Op.log('warn', 'launch.aborted'))
      child.kill()
    }
    signal.addEventListener('abort', abortHandler, { once: true })

    // close 而不是 exit：exit 可能早于 stdout/stderr 排空，而 queue.close() 之后
    // push 会被丢弃——崩溃现场的最后几行恰好是 diag 最需要的
    const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (err) => {
        queue.push(
          Op.log('error', 'launch.spawn_failed', {
            message: spawnErrorMessage(plan.java, err as Error & { code?: string }),
          }),
        )
        resolve({ code: null, sig: null })
      })
      child.on('close', (code, sig) => {
        // 结尾没有换行符的半行也要进 tail/日志
        stdoutSplitter.flush()
        stderrSplitter.flush()
        resolve({ code, sig })
      })
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
    // 主动结束不再自动等于「跑完了」：日志早早停在一条栈帧上，说明游戏先死了，
    // 后面那几十秒只是进程没退（issue #2）
    const diedBeforeStop =
      stopped &&
      Date.now() - lastLineAt >= (opts.heartbeatGraceMs ?? HEARTBEAT_GRACE_MS) &&
      endsWithStack(tail)
    const crashed = diedBeforeStop || (!stopped && (code !== 0 || sig !== null))

    if (diedBeforeStop) {
      yield Op.log('error', 'launch.died_before_stop', {
        idleMs: Date.now() - lastLineAt,
        durationMs,
      })
    } else if (crashed) {
      yield Op.log('error', 'launch.exited_abnormally', { code, signal: sig, durationMs })
    } else {
      yield Op.log('info', 'launch.exited', { code, durationMs })
    }

    if (sink !== null) await sink.close()

    yield Op.result({
      exitCode: code,
      signal: sig,
      durationMs,
      // 「到点结束」只在真的跑到时限时才算：死在中途的要报成崩溃
      stopped: stopped && !diedBeforeStop,
      aborted,
      crashed,
      diedBeforeStop,
      tail,
      lineCount,
      ...(sink === null ? {} : { logPath: sink.path }),
    })
    yield Op.done()
  })
}
