/**
 * flag 的形状与校验。
 *
 * 单独成文件是为了能被测试 import：`index.ts` 顶层就会执行 main()，
 * 测试没法从那里取任何东西。
 *
 * 形状（`takesValue` / 取值占位符 / 帮助）与校验放在一起：一处声明同时喂给
 * `validateFlags` 和 `--help`，两者不可能再各自维护一份 flag 名单。
 */

export interface FlagSpec {
  /** true 表示这个 flag 后面必须跟一个值 */
  readonly takesValue: boolean
  /** 取值占位符，只进帮助：`--root <dir>`。`takesValue` 为 true 时必填 */
  readonly value?: string
  /** 帮助里的说明。省略表示只在用法行里出现，不单独解释 */
  readonly help?: string
  /**
   * 通用 flag：多个子命令都接受，帮助里只解释一次。
   *
   * `--root` 出现在 10 条子命令里，逐个重复一句「数据根目录」只会把
   * 帮助撑长，不会让人多懂一点。
   */
  readonly common?: boolean
  /**
   * 必填。`validateFlags` 会检查它真的出现了。
   *
   * 只有 `install --mods-dir` 用得上：不带这个参数时命令无事可做，
   * 与其进到 handler 再打印整篇帮助，不如在校验这一步说清楚。
   */
  readonly required?: boolean
}

/**
 * 声明时的写法。字符串 = 不取值的开关，字符串本身就是说明。
 *
 * 二十多个开关（`--json` / `--dry-run` / `--china` …）如果每个都写成三行对象，
 * 声明区就没法扫读了。
 */
export type FlagDecl = FlagSpec | string

export function normalizeFlags(
  decl: Readonly<Record<string, FlagDecl>>,
): Readonly<Record<string, FlagSpec>> {
  const out: Record<string, FlagSpec> = {}
  for (const [flag, d] of Object.entries(decl)) {
    out[flag] = typeof d === 'string' ? { takesValue: false, help: d } : d
  }
  return out
}

/**
 * 找第一个不认识的 flag，或需要值却没给值的 flag。返回人话，没问题返回 undefined。
 *
 * 为什么要这张表：以前未知参数被静默忽略，`--json` 拼成 `--jsno` 依然退出 0，
 * 脚本拿到一段人类可读文本去 JSON.parse，错在别处；`--root` 忘了写路径则
 * 悄悄装进默认目录。**静默做错事比报错难查得多。**
 */
export function validateFlags(
  args: readonly string[],
  spec: Readonly<Record<string, FlagSpec>>,
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined || !a.startsWith('--')) continue

    const flag = spec[a]
    if (flag === undefined) return `未知参数 ${a}`
    if (!flag.takesValue) continue

    const value = args[i + 1]
    // 值不能是另一个 flag：`--root --china` 是少写了路径，不是要把 root 设成 "--china"
    if (value === undefined || value.startsWith('--')) return `${a} 需要一个值`
    i += 1
  }

  for (const [flag, f] of Object.entries(spec)) {
    if (f.required === true && !args.includes(flag)) return `缺少必填参数 ${flag}`
  }
  return undefined
}
