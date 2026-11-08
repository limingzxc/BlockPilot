/**
 * 崩溃日志的模式匹配。
 *
 * 这些模式全部来自真实日志，不是猜的：
 * - Fabric / Forge 的依赖解析失败
 * - Java 版本、内存、natives、图形驱动
 * - Mixin 冲突
 *
 * 匹配到之后给出的 hint 必须是**可执行**的，不能只是复述现象。
 * 「Java 版本不对」是现象，「装 Java 17」才是建议。
 */

import { javaInstallHint } from '../hints.js'

export type CrashKind =
  | 'java-version'
  | 'out-of-memory'
  | 'missing-dependency'
  | 'corrupt-jar'
  | 'mod-load-failed'
  | 'mod-conflict'
  | 'mixin'
  | 'natives'
  | 'graphics'
  | 'mod-crash'
  | 'auth-failed'
  | 'unknown'

export interface CrashSignal {
  readonly kind: CrashKind
  readonly severity: 'fatal' | 'warning'
  /** 命中的原始行 */
  readonly message: string
  /** 行号，从 1 开始 */
  readonly line: number
  /** 上下文若干行 */
  readonly excerpt: readonly string[]
  /** 可以照着做的建议 */
  readonly hint: string
  /**
   * 日志里点了名的文件（目前只有 corrupt-jar 用：`Error analyzing [xxx.jar]`）。
   * 比栈帧归因可靠得多——这是日志自己说的。
   */
  readonly subject?: string
  /**
   * 这条异常 Loader 捕获后又降级处理了，游戏照常跑完。
   * 它仍然值一提，但不能算致命，也不该指向任何模组（否则用户会去删它）。
   */
  readonly recoverable?: boolean
}

interface Rule {
  readonly re: RegExp
  readonly kind: CrashKind
  readonly severity: 'fatal' | 'warning'
  readonly hint: string
  /** 同一行还匹配这个时，说明是可恢复的变体，severity 降为 warning */
  readonly recoverableWhen?: RegExp
}

const RULES: readonly Rule[] = [
  // ---- Java 运行时 ----
  {
    re: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/i,
    kind: 'java-version',
    severity: 'fatal',
    hint: `模组或游戏要求的 Java 版本比当前高。装对应版本：${javaInstallHint('<major>')}`,
  },
  {
    re: /java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded/i,
    kind: 'out-of-memory',
    severity: 'fatal',
    hint: '内存不够。把 --memory 调大（如 4096），或减少模组数量',
  },

  // ---- 依赖解析（Fabric / Forge 各有措辞）----
  {
    // **必须排在 missing-dependency 前面。** `ModResolutionException` 是 Fabric
    // 「模组发现失败」的总出口，jar 读不出来也走那条路（issue #3）。顺序反了，
    // 一个损坏的 jar 会被说成「缺前置」，用户照着提示去补依赖，永远修不好。
    re: /Error analyzing \[(.+?)\]:|java\.util\.zip\.ZipException|zip END header not found/i,
    kind: 'corrupt-jar',
    severity: 'fatal',
    hint: '这个 jar 不是完整的压缩包（多半是下载中断）。删掉它重新下载；用 blockpilot install 装可避免',
  },
  {
    re: /Missing or unsupported mandatory dependencies|ModResolutionException|Incompatible mod set/i,
    kind: 'missing-dependency',
    severity: 'fatal',
    hint: '有模组的必需前置缺失或版本不符。跑 preflight 看具体缺什么',
  },
  {
    re: /MissingDependencyException/i,
    kind: 'missing-dependency',
    severity: 'fatal',
    hint: 'Forge 的依赖检查没通过。跑 preflight 看具体缺什么',
  },
  {
    // 这是**结果**不是原因：mixin 冲突、缺依赖、模组自身 bug 都会汇到这里。
    // 判成 fatal 会让它和真正的根因并列，误导用户以为要修好几件事。
    re: /ModLoadingException|Mod loading has failed/i,
    kind: 'mod-load-failed',
    severity: 'warning',
    hint: '这是结果不是原因。往上看它之前的第一条 ERROR，那里才是根因',
  },
  {
    re: /Duplicate mods found|found a duplicate mod|two mods with the same id/i,
    kind: 'mod-conflict',
    severity: 'fatal',
    hint: '同一个模组装了多个版本，删掉 mods/ 里多余的那个',
  },

  // ---- Mixin ----
  {
    re: /MixinApplyError|InvalidMixinException|InvalidInjectionException|Mixin apply failed|MixinTransformerError|Mixin transformation of .* failed/i,
    kind: 'mixin',
    severity: 'fatal',
    /**
     * `Found a remappable @Shadow annotation` 是 Loader 捕获后降级处理的校验失败：
     * 它把这个 mixin 禁掉，游戏照常启动。判成 fatal 的后果很具体——FO（下载量最大的
     * 整合包之一）每次启动都会打这一条，于是每次 diag 都给一条假崩溃，脚本消费
     * `--json` 会当成真崩了（issue #8）。
     */
    recoverableWhen: /Found a remappable @Shadow annotation/i,
    hint: '模组之间的字节码改写冲突。通常是两个模组改同一个类，试着移除最近加的那个',
  },

  // ---- 原生库 ----
  {
    re: /UnsatisfiedLinkError|no lwjgl in java\.library\.path|Could not initialize class org\.lwjgl/i,
    kind: 'natives',
    severity: 'fatal',
    hint: 'natives 没解压或架构不匹配。删掉实例的 natives 目录重跑 setup',
  },

  // ---- 图形 ----
  {
    re: /GLFW error|Failed to create window|Pixel format not accelerated|The driver does not appear to support OpenGL/i,
    kind: 'graphics',
    severity: 'fatal',
    hint: '显卡驱动或 OpenGL 版本不够。更新驱动，或换用 Mesa/软件渲染',
  },

  // ---- 认证 ----
  {
    // 游戏不会因此崩，但只能单机、进不了服务器；错误信息埋在启动前几行，
    // 很容易被当成「网络问题」而永远查不出原因
    // 包住整条 authlib 异常链：`Caused by: ...MinecraftClientHttpException` 是同一件事，
    // 漏了它就会掉进兜底规则，被当成「某个模组的问题」指错方向
    re: /InvalidCredentialsException|Failed to verify authentication|authlib\.exceptions\.|MinecraftClientHttpException|profile key pair/i,
    kind: 'auth-failed',
    severity: 'warning',
    hint: '正版令牌无效或已过期。跑 blockpilot login 重新授权；只玩单机可以忽略',
  },

  // ---- 兜底：任何未被上面覆盖的异常 ----
  {
    // Java 的类名大小写混合（com.example.SomeRandomException），不能只匹配小写
    re: /^\s*(Caused by: )?[\w$.]*(Exception|Error)\b/,
    kind: 'mod-crash',
    severity: 'warning',
    hint: '出现了未归类的异常。看它前面几行的触发点，通常是某个模组',
  },
]

const MAX_EXCERPT = 8

/** `Error analyzing [D:\...\mods\xxx.jar]:` → `xxx.jar`。Windows 与 POSIX 分隔符都要认。 */
function jarFromAnalyzing(line: string): string | undefined {
  const m = /Error analyzing \[(.+?)\]/i.exec(line)
  const p = m?.[1]
  if (p === undefined) return undefined
  const name = p.split(/[\\/]/).pop()
  return name === undefined || name === '' ? undefined : name
}

/**
 * 同一个 kind 只报告一次，后面的是连锁反应。
 *
 * 唯一的例外是「先出现可恢复变体、后来真的崩了」：那条更弱的记录会被替换掉，
 * 否则日志里明明有真崩溃，输出却停在一条 Loader 已经降级处理过的警告上。
 */
export function analyzeLog(lines: readonly string[]): readonly CrashSignal[] {
  const byKind = new Map<CrashKind, number>()
  const signals: CrashSignal[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || line === '') continue

    for (const rule of RULES) {
      if (!rule.re.test(line)) continue

      // 异常的详情常常在下一行（`InvalidMixinException:` 换行再接原因），
      // 所以可恢复判定看一个短的向下窗口，而不只是命中的那一行
      const window = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ')
      const recoverable = rule.recoverableWhen?.test(window) === true
      const known = byKind.get(rule.kind)
      if (known !== undefined) {
        // 已经记过一条真的（或同为可恢复）——后面的都算连锁反应
        if (recoverable || signals[known]?.recoverable !== true) break
      }

      const from = Math.max(0, i - 2)
      const to = Math.min(lines.length, i + MAX_EXCERPT)
      const subject = rule.kind === 'corrupt-jar' ? jarFromAnalyzing(line) : undefined
      const signal: CrashSignal = {
        kind: rule.kind,
        severity: recoverable ? 'warning' : rule.severity,
        message: line.trim(),
        line: i + 1,
        excerpt: lines.slice(from, to),
        hint: recoverable
          ? '这是可恢复的：Loader 已禁用该 mixin 继续启动，只影响对应功能。不用为此删模组'
          : rule.hint,
        ...(subject === undefined ? {} : { subject }),
        ...(recoverable ? { recoverable: true } : {}),
      }

      if (known === undefined) {
        byKind.set(rule.kind, signals.length)
        signals.push(signal)
      } else {
        signals[known] = signal
      }
      break
    }
  }

  /**
   * 损坏的 jar 会先撞上 `ModResolutionException`（Fabric 的总出口），
   * 于是同一份日志里既有「缺前置」又有「zip 坏了」。后者是根因，前者只是结果——
   * 留着两条会让用户按第一条去补依赖（issue #3）。
   */
  if (signals.some((s) => s.kind === 'corrupt-jar')) {
    return signals.filter((s) => s.kind !== 'missing-dependency')
  }

  return signals
}

/** 给出一个最可能的根因：fatal 优先，同级取第一个。 */
export function primarySignal(signals: readonly CrashSignal[]): CrashSignal | null {
  return signals.find((s) => s.severity === 'fatal') ?? signals[0] ?? null
}

/**
 * 这个位置之后，游戏是否还在正常推进。
 *
 * 只匹配异常文本是不够的：`InvalidMixinException` 有两种结局——真的把游戏拦死在
 * 启动阶段，或者 Loader 把那个 mixin 禁掉继续跑。区别不在异常本身，而在**它之后
 * 日志有没有走到下一个里程碑**。只看"出现了什么异常"会把后者误报成崩溃，而用户
 * 收到"崩在 X"之后的第一反应就是去删 X。
 *
 * 里程碑取的是启动过程中确定要经过、且崩溃后不可能再出现的几条。
 */
const ALIVE_MARKERS: readonly RegExp[] = [
  /Backend library: LWJGL/i,
  /Sound engine started/i,
  /Created: .*atlas/i,
  /OpenAL initialized/i,
  /Stopping! \(/i,
]

export function survivedAfter(lines: readonly string[], lineNo: number): boolean {
  // lineNo 是 1-based，从它之后开始找
  for (let i = lineNo; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    if (ALIVE_MARKERS.some((re) => re.test(line))) return true
  }
  return false
}
