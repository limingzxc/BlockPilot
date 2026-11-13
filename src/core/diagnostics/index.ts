import { existsSync, readFileSync } from 'node:fs'

import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import type { Culprit, ModIndex } from './attribution.js'
import { attributeCulprits, buildModIndex, EMPTY_INDEX } from './attribution.js'
import type { CrashKind, CrashSignal } from './crash.js'
import { analyzeLog, primarySignal, survivedAfter } from './crash.js'
import type { CrashReportInfo } from './crash-report.js'
import { descriptionSignal, parseCrashReport } from './crash-report.js'
import { parseFrames } from './frames.js'
import type { DiagFormat } from './hs-err.js'
import { analyzeHsErr, detectFormat, parseHsErrFrames } from './hs-err.js'

/** 这些 kind 的结论会因「指向了谁」而变；运行时的（Java/内存/显卡）不会。 */
const ATTRIBUTABLE: ReadonlySet<CrashKind> = new Set(['mod-crash', 'mod-load-failed', 'mixin'])

/**
 * 人类可读的模组名。
 *
 * `Controlify（controlify）` 这种输出只是把同一个词写了两遍——只有当显示名
 * 和 modId 明显不同时，才值得把 modId 也带上（用户要在 mods/ 里找文件）。
 */
function modLabel(c: Culprit): string {
  if (c.name === undefined) return c.modId
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (normalize(c.name) === normalize(c.modId)) return c.name
  return `${c.name}（${c.modId}）`
}

/**
 * 把归属结果并进根因的 hint。
 *
 * 原本 `mod-crash` 的 hint 是「看它前面几行的触发点，通常是某个模组」——
 * 那是**没有归属能力时**能说的话。现在既然知道是谁了，就不该再让用户自己找。
 *
 * 只改被归因影响的 kind：显卡驱动报错时把锅推给某个模组是错的。
 */
function applyAttribution(
  primary: CrashSignal,
  top: Culprit | undefined,
  crashed: boolean,
): CrashSignal {
  if (top === undefined) return primary
  if (!ATTRIBUTABLE.has(primary.kind)) return primary
  // 证据太弱就不改结论。一条「包名看着像」不足以让用户去删模组
  if (top.score < 40) return primary

  const label = modLabel(top)
  // 「崩在」是一个结论。没有致命异常时只能说「与它有关」——
  // 否则用户会照着删掉一个其实没问题的模组
  const hint =
    primary.kind === 'mod-crash'
      ? `异常来自 ${label}，文件 ${top.fileName}。先禁用或更新它，看崩溃是否消失`
      : crashed
        ? `${primary.hint}。本次崩在 ${label}`
        : `${primary.hint}。其中提到 ${label}，但日志里没有致命异常，未必是它导致的`

  return { ...primary, hint }
}

export interface DiagOptions {
  readonly logPath: string
  /** 实例的 mods 目录。给了才能把栈帧归到具体模组 */
  readonly modsDir?: string
  /**
   * 预建的包名索引。给了就不扫 mods 目录。
   *
   * 索引的生命周期是调用方的事，不是调用链内部细节——MCP 高频调用时可以
   * 自己缓存（按 mtime 失效），同一旅程的 preflight 也能复用同一份 jar 读取。
   * 不给就走缺省：每次全量扫（46 模组约 635ms）。
   */
  readonly index?: ModIndex
}

export type DiagVerdict = 'crash' | 'inconclusive' | 'clean'

export interface DiagResult {
  readonly logPath: string
  /** 输入文件的格式：普通日志 / hs_err / Minecraft crash-report */
  readonly format: DiagFormat
  /** crash-report 才有：Description / MC 版本 / 模组数 */
  readonly crashReport?: CrashReportInfo
  readonly lineCount: number
  readonly signals: readonly CrashSignal[]
  readonly primary: CrashSignal | null
  /**
   * - crash：找到明确的致命原因
   * - inconclusive：只找到未归类的异常，可能是崩溃也可能只是某个模组的警告
   * - clean：日志里没有任何异常
   */
  readonly verdict: DiagVerdict
  /** 按证据强度排序的嫌疑模组。空数组表示定位不到 */
  readonly culprits: readonly Culprit[]
  /** 定位不到时的解释，告诉用户缺了什么信息 */
  readonly attributionNotes: readonly string[]
  /** 解析到的栈帧数，用于区分「没崩」和「崩了但没栈」 */
  readonly frameCount: number
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

    // hs_err 不是日志：它没有 `at ...` 栈帧，只有信号与问题帧。
    // 用 analyzeLog 扫它会把「JVM 整个死了」判成 clean。
    const format = detectFormat(text)
    const crashReport = format === 'crash-report' ? parseCrashReport(lines) : null
    const rawSignals = [...(format === 'hs-err' ? analyzeHsErr(lines) : analyzeLog(lines))]

    // 摘要在「没有任何其它致命信号」时才兜底：mixin 崩溃报告也常写
    // Description: Rendering overlay，不能让它把更具体的 mixin 结论盖掉
    if (
      crashReport !== null &&
      rawSignals.every((s) => s.severity !== 'fatal') &&
      crashReport.descriptionLine !== undefined
    ) {
      const signal = descriptionSignal(crashReport, crashReport.descriptionLine)
      if (signal !== null) rawSignals.push(signal)
    }
    const rawPrimary = primarySignal(rawSignals)

    const frames = format === 'hs-err' ? parseHsErrFrames(lines) : parseFrames(lines)
    const index =
      opts.index ??
      (opts.modsDir === undefined || !existsSync(opts.modsDir)
        ? EMPTY_INDEX
        : buildModIndex(opts.modsDir))
    const attribution = attributeCulprits({ lines, index, frames })

    // 先定结论，再拼措辞：hint 里能不能说「崩在」取决于这个结论。
    // 有 fatal 信号还不够——要看这条之后游戏有没有继续走到启动里程碑，
    // 否则 Controlify 这种「mixin 被禁用但游戏照跑」会被报成崩溃。
    const survived = rawPrimary !== null && survivedAfter(lines, rawPrimary.line)
    const verdict: DiagVerdict =
      rawPrimary === null
        ? 'clean'
        : survived || rawPrimary.severity !== 'fatal'
          ? 'inconclusive'
          : 'crash'

    // 结论要带着「指向谁」一起说，否则用户读到的是一条没有主语的建议。
    // 可恢复的那条不指向任何人：Loader 已经把它处理掉了，点名只会让用户去删模组。
    const recovered = rawPrimary !== null && rawPrimary.recoverable === true && verdict !== 'crash'
    const primary =
      rawPrimary === null || recovered
        ? rawPrimary
        : applyAttribution(rawPrimary, attribution.culprits[0], verdict === 'crash')

    // 把增强过的根因放回数组里。否则消费者按引用去重时，
    // 原始的那条会被当成「其他线索」再打印一次
    const signals = rawSignals.map((s) => (s === rawPrimary ? (primary ?? s) : s))

    const culprits = recovered ? [] : attribution.culprits
    const attributionNotes = recovered
      ? [
          '命中的是可恢复的 mixin 校验失败（Loader 会禁用它继续启动），不指向任何模组',
          ...attribution.notes,
        ]
      : attribution.notes

    yield Op.log('info', 'diag.done', {
      format,
      ...(crashReport?.description === undefined ? {} : { description: crashReport.description }),
      lines: lines.length,
      signals: signals.length,
      verdict,
      primary: primary?.kind,
      frames: frames.length,
      culprits: culprits.length,
    })

    yield Op.result({
      logPath: opts.logPath,
      format,
      ...(crashReport === null ? {} : { crashReport }),
      lineCount: lines.length,
      signals,
      primary,
      verdict,
      culprits,
      attributionNotes,
      frameCount: frames.length,
    })
    yield Op.done()
  })
}
