import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

/** 保留多少个历史日志。一次游戏会话通常几 MB，10 个足够回溯。 */
const KEEP = 10

/**
 * 只认我们自己写的文件：`2026-10-25T11-57-12-1.20.1.log`。
 *
 * 游戏自己也会往同一个目录写 `latest.log`（内容和我们的一致），
 * 轮转时绝不能碰它——那是 Minecraft 自己的日志管理，动了会让别的工具读不到。
 */
const OUR_LOG = /^\d{4}-\d{2}-\d{2}T/

export interface LogSink {
  readonly path: string
  write(line: string): void
  close(): Promise<void>
}

function prune(logsDir: string): void {
  let names: string[]
  try {
    names = readdirSync(logsDir).filter((n) => n.endsWith('.log') && OUR_LOG.test(n))
  } catch {
    return
  }
  if (names.length <= KEEP) return

  const withTime = names
    .map((n) => {
      const full = join(logsDir, n)
      try {
        return { full, mtime: statSync(full).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime)

  for (const old of withTime.slice(KEEP)) {
    try {
      unlinkSync(old.full)
    } catch {
      // 删不掉不影响本次写入
    }
  }
}

/**
 * 打开一份会话日志。
 *
 * 文件名用 `时间戳-版本.log` 而不是固定 `latest.log`：同一天跑两次原版和 Forge，
 * 固定名会互相覆盖，而崩溃现场最怕的就是「上一次的日志被这次冲掉了」。
 */
export function openLogFile(logsDir: string, versionId: string): LogSink {
  mkdirSync(logsDir, { recursive: true })
  prune(logsDir)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeVersion = versionId.replace(/[^A-Za-z0-9._-]+/g, '_')
  const path = join(logsDir, `${stamp}-${safeVersion}.log`)

  const stream = createWriteStream(path, { flags: 'a' })
  let closed = false

  return {
    path,
    write(line: string): void {
      if (closed) return
      stream.write(`${line}\n`)
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      closed = true
      return new Promise<void>((resolve) => {
        stream.end(() => resolve())
      })
    },
  }
}

export interface LogEntry {
  readonly name: string
  readonly path: string
  readonly size: number
  readonly mtime: number
  /** 游戏自己写的（latest.log 等），不是我们的会话日志 */
  readonly native: boolean
}

/** 列出日志文件，新的在前。供 CLI 的 logs 命令用。 */
export function listLogs(logsDir: string): LogEntry[] {
  if (!existsSync(logsDir)) return []
  const out: LogEntry[] = []
  for (const name of readdirSync(logsDir)) {
    if (!name.endsWith('.log')) continue
    const full = join(logsDir, name)
    try {
      const st = statSync(full)
      out.push({
        name,
        path: full,
        size: st.size,
        mtime: st.mtimeMs,
        native: !OUR_LOG.test(name),
      })
    } catch {
      // 单个文件读不到就跳过
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
