import { existsSync, readFileSync } from 'node:fs'

import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import { analyzeLog, primarySignal } from './crash.js'
import type { CrashSignal } from './crash.js'

export interface DiagOptions {
  readonly logPath: string
}

export type DiagVerdict = 'crash' | 'inconclusive' | 'clean'

export interface DiagResult {
  readonly logPath: string
  readonly lineCount: number
  readonly signals: readonly CrashSignal[]
  readonly primary: CrashSignal | null
  /**
   * - crash：找到明确的致命原因
   * - inconclusive：只找到未归类的异常，可能是崩溃也可能只是某个模组的警告
   * - clean：日志里没有任何异常
   */
  readonly verdict: DiagVerdict
}

export function createDiagnose(opts: DiagOptions): Operation<DiagResult> {
  return defineOperation<DiagResult>('diag', async function* (signal) {
    if (!existsSync(opts.logPath)) {
      yield Op.failed('LOG_NOT_FOUND', `找不到日志：${opts.logPath}`, '先跑一次 run')
      return
    }

    const text = readFileSync(opts.logPath, 'utf8')
    const lines = text.split(/\r?\n/)
    if (signal.aborted) return

    const signals = analyzeLog(lines)
    const primary = primarySignal(signals)
    const verdict: DiagVerdict =
      primary === null ? 'clean' : primary.severity === 'fatal' ? 'crash' : 'inconclusive'

    yield Op.log('info', 'diag.done', {
      lines: lines.length,
      signals: signals.length,
      verdict,
      primary: primary?.kind,
    })

    yield Op.result({
      logPath: opts.logPath,
      lineCount: lines.length,
      signals,
      primary,
      verdict,
    })
    yield Op.done()
  })
}
