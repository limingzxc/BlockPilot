/**
 * Minecraft 的 `crash-reports/crash-*.txt`。
 *
 * 它不是普通日志：开头有一段稳定的摘要（`Description:`），末尾是
 * `-- System Details --`。`analyzeLog` 只扫栈，摘要里的信息全丢了。
 *
 * 这里做两件低风险的事：
 * 1. 解析 Description / Minecraft Version / Loaded Mods，暴露给消费者
 * 2. 只在**没有任何其他致命信号**时，用 Description 兜一条结论
 *
 * 第 2 条的「只在」很重要：一个 mixin 崩溃报告也常写
 * `Description: Rendering overlay`，若让摘要抢成 primary，会把更具体的
 * mixin 结论盖掉。
 */

import { redactSecrets } from '../redact.js'
import type { CrashSignal } from './crash.js'

const HEADER = '---- Minecraft Crash Report ----'

export interface CrashReportInfo {
  readonly description?: string
  /** Description 所在行（1 基）。没有摘要时为 undefined */
  readonly descriptionLine?: number
  readonly gameVersion?: string
  readonly loadedMods: number
}

export function isCrashReport(text: string): boolean {
  return text.includes(HEADER)
}

export function parseCrashReport(lines: readonly string[]): CrashReportInfo | null {
  let header = -1
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').startsWith(HEADER)) {
      header = i
      break
    }
  }
  if (header === -1) return null

  let description: string | undefined
  let descriptionLine: number | undefined
  let gameVersion: string | undefined
  let loadedMods = 0
  let inLoadedMods = false

  for (let i = header; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const desc = /^Description:\s*(.+)$/.exec(line)
    if (desc?.[1] !== undefined && description === undefined) {
      description = desc[1].trim()
      descriptionLine = i + 1
    }

    const version = /^\s*Minecraft Version:\s*(.+)$/.exec(line)
    if (version?.[1] !== undefined && gameVersion === undefined) gameVersion = version[1].trim()

    if (/^\s*Loaded Mods:\s*$/.test(line)) {
      inLoadedMods = true
      continue
    }
    if (inLoadedMods) {
      // 模组条目形如 `\t\t- modid 1.0.0`；遇到别的段就结束
      if (/^\s*-\s+\S+/.test(line)) loadedMods += 1
      else if (line.trim() !== '') inLoadedMods = false
    }
  }

  return {
    ...(description === undefined ? {} : { description }),
    ...(descriptionLine === undefined ? {} : { descriptionLine }),
    ...(gameVersion === undefined ? {} : { gameVersion }),
    loadedMods,
  }
}

function classify(description: string): {
  kind: CrashSignal['kind']
  hint: string
} {
  const d = description.toLowerCase()
  if (d.includes('ticking')) {
    return {
      kind: 'mod-crash',
      hint: '崩在实体/方块 tick。通常是某个模组处理该实体或方块时出错；看栈里第一个非原版的类',
    }
  }
  if (d.includes('rendering') || d.includes('shader')) {
    return {
      kind: 'graphics',
      hint: '崩在渲染阶段。先更新显卡驱动；再禁用光影/渲染优化类模组（Sodium、Iris、OptiFine）排查',
    }
  }
  if (d.includes('initializing') || d.includes('loading')) {
    return {
      kind: 'mod-load-failed',
      hint: '崩在初始化/加载阶段。先看栈里的 mixin 或 mods.toml 报错，通常是某个模组与当前版本不兼容',
    }
  }
  return {
    kind: 'mod-crash',
    hint: '崩溃报告给出了摘要，但栈没有解析出可用帧；把报告开头的 Description 与第一个 Caused by 贴出来',
  }
}

/** 仅在其它规则没给出致命信号时调用。 */
export function descriptionSignal(info: CrashReportInfo, line: number): CrashSignal | null {
  if (info.description === undefined || info.description === '') return null
  const { kind, hint } = classify(info.description)
  return {
    kind,
    severity: 'fatal',
    message: redactSecrets(`崩溃报告：${info.description}`),
    line,
    excerpt: [],
    hint,
  }
}
