/**
 * 从日志里解析 Java 栈帧。
 *
 * 只做一件事：把 `at com.example.Foo.bar(Foo.java:42)` 变成结构化的帧，
 * 并顺手把日志里已经写明的归属信息抠出来——这些信息比任何猜测都可靠：
 *
 * - Forge/ModLauncher 在帧尾附来源：`~[jei-1.20.1-15.74.0.jar%23123!/:?]`
 * - Fabric 的 mixin 处理器方法名内嵌 mod id：`handler$zcb000$sodium$method_1234`
 *
 * 拿不到这两样时，才会退到「包名 → 模组」的推断（见 attribution.ts）。
 */

export interface StackFrame {
  /** 行号，从 1 开始 */
  readonly line: number
  readonly className: string
  readonly method: string
  readonly sourceFile?: string
  readonly sourceLine?: number
  /** 帧尾 `~[...]` 里的文件名，已去掉 `%23xxx!/:?` 这类修饰 */
  readonly sourceJar?: string
  /** 方法名里带的 mod id（Fabric mixin 的 handler$hash$modid$method） */
  readonly mixinModId?: string
}

/**
 * 帧格式。前缀可能是 `[20:20:07] [main/ERROR]: `，也可能是裸的 `\tat `，
 * 所以只锚定 `at ` 之前的一个分隔符，不假设日志前缀长什么样。
 */
const FRAME_RE = /(?:^|[\]:\s])at\s+([\w$./]+)\.([\w$<>]+)\(([^)]*)\)/

/** 帧尾的来源标注：` ~[foo.jar%23123!/:?]` */
const SOURCE_RE = /\s*~\[([^\]]+)\]/

/** Fabric / Forge 的 mixin 处理器方法名 */
const MIXIN_HANDLER_RE = /^handler\$[a-z0-9]+\$([a-z0-9_]+)\$/

/** `<init>` `<clinit>` 这种尖括号方法名要保留，否则构造函数帧会被丢掉 */
function splitClassMethod(token: string): { className: string; method: string } | null {
  const cut = token.lastIndexOf('.')
  if (cut <= 0) return null
  // Lambda 的隐藏类名形如 `com.example.Foo$$Lambda$1/0x0000000800c0`，斜杠后面是地址，去掉
  const className = token.slice(0, cut).split('/')[0] ?? ''
  const method = token.slice(cut + 1)
  if (className === '' || method === '') return null
  return { className, method }
}

/** `foo.jar%23123!/:?` → `foo.jar` */
export function jarNameOf(source: string): string | null {
  const m = /^(.*?\.jar)/i.exec(source)
  return m?.[1] ?? null
}

function parseSource(rest: string): {
  sourceJar?: string
  sourceFile?: string
  sourceLine?: number
} {
  const out: { sourceJar?: string; sourceFile?: string; sourceLine?: number } = {}

  const jarMatch = SOURCE_RE.exec(rest)
  if (jarMatch?.[1] !== undefined) {
    const name = jarNameOf(jarMatch[1])
    if (name !== null) out.sourceJar = name
  }
  return out
}

/**
 * 解析一行的帧。返回 null 表示这行不是栈帧。
 *
 * `(...)` 里的内容只接受三种真实写法：`Foo.java:42`、`Native Method`、
 * `Unknown Source`。不校验这一点的话，任何含 "at " 的英文句子都会被当成帧。
 *
 * 源码文件名**不能只认 `.java`**：Kotlin 写的模组会给出 `RenderUtils.kt:88`，
 * 而 controlify、fabric-language-kotlin 生态里这种帧到处都是。
 * 只认 .java 会让这些模组的崩溃完全转移不到它们头上。
 */
const JAVA_FILE_RE = /^[\w$]+(\.\w+)*\.\w+:\d+$/
export function parseFrame(line: string, lineNo: number): StackFrame | null {
  const m = FRAME_RE.exec(line)
  if (m === null) return null

  const classPart = m[1]
  const methodPart = m[2]
  const location = m[3]
  if (classPart === undefined || methodPart === undefined || location === undefined) return null

  const isJavaFile = JAVA_FILE_RE.test(location)
  const isNative = location === 'Native Method' || location === 'Unknown Source' || location === ''
  if (!isJavaFile && !isNative) return null

  const split = splitClassMethod(`${classPart}.${methodPart}`)
  if (split === null) return null

  const afterParen = line.slice((m.index ?? 0) + m[0].length)
  const source = parseSource(afterParen)

  let sourceFile: string | undefined
  let sourceLine: number | undefined
  if (isJavaFile) {
    const cut = location.lastIndexOf(':')
    sourceFile = location.slice(0, cut)
    const n = Number(location.slice(cut + 1))
    if (Number.isFinite(n)) sourceLine = n
  }

  const mixin = MIXIN_HANDLER_RE.exec(split.method)

  return {
    line: lineNo,
    className: split.className,
    method: split.method,
    ...(sourceFile === undefined ? {} : { sourceFile }),
    ...(sourceLine === undefined ? {} : { sourceLine }),
    ...(source.sourceJar === undefined ? {} : { sourceJar: source.sourceJar }),
    ...(mixin?.[1] === undefined ? {} : { mixinModId: mixin[1] }),
  }
}

/** 解析整个日志里的所有帧，保持出现顺序。 */
export function parseFrames(lines: readonly string[]): readonly StackFrame[] {
  const out: StackFrame[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined || line === '') continue
    if (!line.includes('at ')) continue
    const frame = parseFrame(line, i + 1)
    if (frame !== null) out.push(frame)
  }
  return out
}

/**
 * 深层根因的起点（0 基行号）。
 *
 * 一个崩溃现场通常长这样：
 *
 *   java.lang.RuntimeException: ...
 *       at com.example.A.run(A.java:1)        ← 表层
 *   Caused by: java.lang.NullPointerException
 *       at com.example.mod.B.boom(B.java:42)  ← 真正的抛出点
 *
 * 最后一条 `Caused by` 之后的帧才是根因的现场，前面的都是被包裹的转手过程。
 */
export function rootCauseStart(lines: readonly string[]): number {
  let found = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line !== undefined && line.includes('Caused by:')) found = i
  }
  return found
}
