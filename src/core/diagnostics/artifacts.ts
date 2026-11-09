/**
 * 找到实例里最值得看的崩溃证据。
 *
 * 用户说「为什么崩了」时，证据不一定在 `logs/latest.log`：
 * - JVM 原生崩溃写的是游戏根目录的 `hs_err_pid*.log`
 * - 游戏自己崩会写 `crash-reports/crash-*.txt`
 * - 正常会话是 `logs/<时间戳>.log`
 *
 * 以前 `diag` 只看最后一种，于是 hs_err 场景下会回「没有会话日志」。
 * 这里把三类按修改时间排在一起，让调用方挑最新的一份。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { listLogs } from '../launch/logfile.js'

export type CrashArtifactKind = 'hs-err' | 'crash-report' | 'log'

export interface CrashArtifact {
  readonly path: string
  readonly kind: CrashArtifactKind
  readonly mtimeMs: number
}

function push(out: CrashArtifact[], path: string, kind: CrashArtifactKind): void {
  try {
    const st = statSync(path)
    if (!st.isFile()) return
    out.push({ path, kind, mtimeMs: st.mtimeMs })
  } catch {
    // 读不到就跳过：这里只做发现，不负责报权限错误
  }
}

/** 三类证据按修改时间倒序。空数组表示这个实例还没有任何崩溃证据。 */
export function findCrashArtifacts(gameDir: string): readonly CrashArtifact[] {
  const out: CrashArtifact[] = []

  // hs_err 通常落在游戏根目录（进程 cwd）
  if (existsSync(gameDir)) {
    for (const name of readdirSync(gameDir)) {
      if (/^hs_err_pid\d+\.log$/i.test(name)) push(out, join(gameDir, name), 'hs-err')
    }
  }

  const crashDir = join(gameDir, 'crash-reports')
  if (existsSync(crashDir)) {
    for (const name of readdirSync(crashDir)) {
      if (/^crash-.*\.txt$/i.test(name)) push(out, join(crashDir, name), 'crash-report')
    }
  }

  for (const log of listLogs(join(gameDir, 'logs'))) {
    // debug.log 是逐帧调试输出，几 MB 且没有结论，排在候选里只会误导
    if (log.name === 'debug.log') continue
    out.push({ path: log.path, kind: 'log', mtimeMs: log.mtime })
  }

  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
