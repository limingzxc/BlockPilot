/**
 * HotSpot 的 `hs_err_pid*.log`。
 *
 * 这份文件和游戏日志是两种东西：它由 JVM 在**原生崩溃**时直接写出，
 * 没有 Java 异常栈，只有信号、问题帧和寄存器。用 `analyzeLog` 去扫它，
 * 最多命中一个 `OutOfMemoryError`，其余全被当成「没有异常」——用户拿到的
 * 结论是 `clean`，而游戏刚刚整个 JVM 都死了。
 *
 * 这里只做三件有证据的事：
 * 1. 认出这是 hs_err（不是普通日志）
 * 2. 从信号与问题帧判断崩溃类别（内存 / 显卡 / 原生库 / JVM 自身）
 * 3. 把 `Java frames:` 段转成 `StackFrame`，交给现有的归属逻辑
 */

import { redactSecrets } from '../redact.js'
import type { CrashSignal } from './crash.js'
import type { StackFrame } from './frames.js'

const HEADER = '# A fatal error has been detected by the Java Runtime Environment'
const PROBLEMATIC = '# Problematic frame:'
const SIGNAL_RE = /^#\s+(EXCEPTION_[A-Z_]+|SIG[A-Z0-9]+)\b/

/**
 * 显卡 / 图形栈的原生库。
 *
 * 必须是完整库名加边界，不能用 `atio` / `ig[0-9]?d` 这类子串：Linux/macOS 的
 * 问题帧带符号名，`...allocation...`、`...initialization...` 都会命中 `atio`，
 * 把 JVM 内部崩溃误报成显卡驱动；反过来 `ig[0-9]?d` 又漏掉真实的 Intel DLL
 * （ig9icd64.dll）。
 */
const GRAPHICS_LIBS: readonly string[] = [
  // Windows：OpenGL / Vulkan / D3D 驱动
  'opengl32\\.dll',
  'nvoglv(?:32|64)?\\.dll',
  'nvd3dum(?:64)?\\.dll',
  'nvwgf2um(?:64)?\\.dll',
  'atio6axx\\.dll',
  'atioglxx\\.dll',
  'atidxx(?:32|64)?\\.dll',
  'amdvlk(?:32|64)?\\.dll',
  'amdxc(?:32|64)?\\.dll',
  'amdxx(?:32|64)?\\.dll',
  'ig\\d{1,2}icd(?:64)?\\.dll',
  'igd\\d{2}\\w*\\.dll',
  'glfw3?\\.dll',
  'lwjgl(?:_opengl|_vulkan)?\\.dll',
  'vulkan-1\\.dll',
  // Linux
  'libGL(?:X|ESv2)?\\.so(?:\\.\\d+)*',
  'libEGL\\.so(?:\\.\\d+)*',
  'libOpenGL\\.so(?:\\.\\d+)*',
  'libvulkan\\.so(?:\\.\\d+)*',
  'libglfw\\.so(?:\\.\\d+)*',
  'liblwjgl\\.so',
  '(?:radeonsi|swrast|iris|i965|zink|llvmpipe)_dri\\.so',
  // macOS
  'libGL\\.dylib',
  'libMoltenVK\\.dylib',
  'libglfw\\.dylib',
  'OpenGL\\.framework',
  'Metal\\.framework',
]

const GRAPHICS_RE = new RegExp(`(?<![a-z0-9_])(?:${GRAPHICS_LIBS.join('|')})(?![a-z0-9_])`, 'i')

export type DiagFormat = 'log' | 'hs-err' | 'crash-report'

/** 只看头部，不猜内容。 */
export function detectFormat(text: string): DiagFormat {
  if (text.includes(HEADER)) return 'hs-err'
  if (text.includes('---- Minecraft Crash Report ----')) return 'crash-report'
  return 'log'
}

function hintFor(kind: CrashSignal['kind']): string {
  switch (kind) {
    case 'out-of-memory':
      return 'JVM 的堆或本机内存耗尽。先降低 -Xmx、关掉其他程序；若发生在加载阶段，检查模组是否泄漏'
    case 'graphics':
      return '崩溃在显卡驱动 / OpenGL。先更新显卡驱动；笔记本双显卡时强制用独显；OptiFine/Sodium 与驱动版本冲突也常见'
    case 'natives':
      return 'JVM 在原生库（非 Java 代码）里崩了。常见来源是显卡驱动、LWJGL 或模组的本地库；先更新驱动，再逐个禁用最近安装的模组'
    default:
      return 'JVM 自身崩溃。先确认 JDK 与系统架构匹配；把 hs_err 文件开头 80 行贴出来可进一步定位'
  }
}

/**
 * 解析 hs_err。返回 0 或 1 条 fatal 信号。
 *
 * `Problematic frame` 后面那一行才是帧本身：
 *   # Problematic frame:
 *   # C  [lwjgl.dll+0x1a2b]
 */
export function analyzeHsErr(lines: readonly string[]): readonly CrashSignal[] {
  let headerLine = -1
  let signalText = ''
  let problemFrame = ''

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (headerLine === -1 && line.startsWith(HEADER)) headerLine = i
    if (signalText === '') {
      const m = SIGNAL_RE.exec(line)
      if (m?.[1] !== undefined) signalText = m[1]
    }
    if (line === PROBLEMATIC) {
      const next = lines[i + 1] ?? ''
      problemFrame = next.replace(/^#\s*/, '').trim()
    }
  }

  if (headerLine === -1) return []

  const text = lines.join('\n')
  /**
   * 问题帧的类型字母：C=原生库，V=VM 代码，J/j=Java 代码。
   *
   * 只有 C 帧才可能是显卡驱动；V 帧是 JVM 自身，J/j 是 JIT 编译后的 Java 代码。
   * 以前不看这个字母，JVM 内部崩溃也会被归成「显卡驱动/原生库」。
   */
  const frameKind = /^([A-Za-z])\s/.exec(problemFrame)?.[1]?.toUpperCase()
  let kind: CrashSignal['kind']
  if (/OutOfMemoryError/.test(text)) kind = 'out-of-memory'
  else if (frameKind === 'C') kind = GRAPHICS_RE.test(problemFrame) ? 'graphics' : 'natives'
  else if (frameKind === 'V' || frameKind === 'J') kind = 'unknown'
  else if (signalText !== '' || /Problematic frame/.test(text)) kind = 'natives'
  else kind = 'unknown'

  const jar = /([\w.-]+\.jar)/i.exec(problemFrame)?.[1]
  const message =
    signalText === ''
      ? (lines[headerLine] ?? HEADER)
      : `${lines[headerLine] ?? HEADER}（${signalText}${problemFrame === '' ? '' : ` · ${problemFrame}`}）`

  const from = Math.max(0, headerLine - 1)
  const to = Math.min(lines.length, headerLine + 24)

  return [
    {
      kind,
      severity: 'fatal',
      message: redactSecrets(message),
      line: headerLine + 1,
      excerpt: lines.slice(from, to).map(redactSecrets),
      hint: hintFor(kind),
      ...(jar === undefined ? {} : { subject: jar }),
    },
  ]
}

/**
 * `Java frames:` 段的帧格式与普通日志不同：
 *   j  org.lwjgl.system.JNI.invokePV(JJ)V+8
 *   J 1234 c1 com.example.Foo.bar()V (Foo.java:42)
 * 没有 `at `，括号里是 JVM 描述符而不是源码位置。这里只取类名/方法名，
 * 源码位置与来源 jar 都拿不到——归属逻辑靠包名匹配，够用。
 */
const HS_FRAME_RE = /^[jJ]\s+(?:\d+\s+\S+\s+)?([\w$./]+)\.([\w$<>]+)\(/

export function parseHsErrFrames(lines: readonly string[]): readonly StackFrame[] {
  const out: StackFrame[] = []
  let inFrames = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    if (!inFrames) {
      if (line.startsWith('Java frames:')) inFrames = true
      continue
    }
    if (line === '' || line.startsWith('---------------')) break
    const m = HS_FRAME_RE.exec(line)
    if (m === null) continue
    const className = m[1]
    const method = m[2]
    if (className === undefined || method === undefined) continue
    out.push({ line: i + 1, className, method })
  }
  return out
}
