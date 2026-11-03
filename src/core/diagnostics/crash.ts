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

export type CrashKind =
  | 'java-version'
  | 'out-of-memory'
  | 'missing-dependency'
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
}

interface Rule {
  readonly re: RegExp
  readonly kind: CrashKind
  readonly severity: 'fatal' | 'warning'
  readonly hint: string
}

const RULES: readonly Rule[] = [
  // ---- Java 运行时 ----
  {
    re: /UnsupportedClassVersionError|has been compiled by a more recent version of the Java Runtime/i,
    kind: 'java-version',
    severity: 'fatal',
    hint: '模组或游戏要求的 Java 版本比当前高。装对应版本：blockpilot java install <major>',
  },
  {
    re: /java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded/i,
    kind: 'out-of-memory',
    severity: 'fatal',
    hint: '内存不够。把 --memory 调大（如 4096），或减少模组数量',
  },

  // ---- 依赖解析（Fabric / Forge 各有措辞）----
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

/** 同一个 kind 只报告第一次命中，后面的是连锁反应。 */
export function analyzeLog(lines: readonly string[]): readonly CrashSignal[] {
  const seen = new Set<CrashKind>()
  const signals: CrashSignal[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || line === '') continue

    for (const rule of RULES) {
      if (!rule.re.test(line)) continue
      if (seen.has(rule.kind)) break
      seen.add(rule.kind)

      const from = Math.max(0, i - 2)
      const to = Math.min(lines.length, i + MAX_EXCERPT)
      signals.push({
        kind: rule.kind,
        severity: rule.severity,
        message: line.trim(),
        line: i + 1,
        excerpt: lines.slice(from, to),
        hint: rule.hint,
      })
      break
    }
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
