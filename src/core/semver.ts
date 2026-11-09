/**
 * 够用的版本范围判断。
 *
 * 两套语法都要支持，因为同一份实例里两种 mod 都有：
 * - Fabric 用 semver 表达式：`>=0.16.10`、`>=1.20.1 <1.21`、`1.20.x`
 * - Forge 用 Maven 范围：`[1.20.1,1.21)`、`[0.6.10,)`
 *
 * 刻意不追求完整：不处理预发布标签（`1.0.0-beta.1`）的排序。`~` / `^`
 * 已按 npm 约定展开（Fabric 生态里大量使用），见 {@link satisfiesTildeCaret}。
 * 遇到不认识的写法一律返回 `'unknown'`，让调用方决定是忽略还是提示，
 * 而不是猜一个答案。
 */

export type RangeVerdict = 'satisfied' | 'violated' | 'unknown'

/**
 * 版本区间写在哪个生态里。**同一个字符串，含义可能相反。**
 *
 * - `forge` / `neoforge`：裸版本号（`versionRange = "1.0.0"`）是「推荐版本」，
 *   `VersionRange.createFromVersionSpec("1.0.0").hasRestrictions() == false`，
 *   `containsVersion(2.6.1)` 返回 true。作者只是填了「我测试用的版本」。
 * - `fabric`：`depends` 里的裸版本号就是精确匹配，`"1.0.0"` 不接受 `1.0.1`。
 *
 * 按 Fabric 的语义去读 Forge 的 `1.0.0`，会让 `citadel_fix`（要求 1.0.0、
 * 实际 2.6.1）这类写法整包被判 BLOCKED，而游戏其实跑得好好的。
 */
export type RangeDialect = 'forge' | 'fabric' | 'any'

function parseVersion(v: string): number[] | null {
  const cleaned = v.trim().replace(/^v/, '')
  if (cleaned === '') return null
  // 去掉预发布后缀，但保留主版本号
  const core = cleaned.split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    if (p === '' || p === 'x' || p === 'X' || p === '*') {
      nums.push(0)
      continue
    }
    const n = Number(p)
    if (!Number.isFinite(n)) return null
    nums.push(n)
  }
  return nums
}

function compare(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

/**
 * 比较两个版本号。看不懂的写法返回 null，让调用方自己决定怎么办。
 *
 * 只比数字段：`26.2` 与 `26.1.2` 能正确分出大小，`26.4-snapshot-1` 按 `26.4` 处理。
 * 预发布标签的先后关系没有权威定义，这里不做精确排序——用来判断
 * 「目标版本是否高于模组声明过的最高版本」已经够用。
 */
export function compareVersions(a: string, b: string): number | null {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (va === null || vb === null) return null
  return compare(va, vb)
}

/** Maven 范围：[1.20.1,1.21) / [0.6.10,) / (,1.21] / [1.20.1] */
function satisfiesMaven(version: number[], range: string): RangeVerdict {
  const m = /^([[（(])([^,\])]*)(,?)([^,\])]*)([\]）)])$/.exec(range.trim())
  if (m === null) return 'unknown'
  const [, open, loRaw, comma, hiRaw, close] = m
  if (open === undefined || close === undefined) return 'unknown'

  const lo = loRaw === undefined || loRaw === '' ? null : parseVersion(loRaw)
  const hi = hiRaw === undefined || hiRaw === '' ? null : parseVersion(hiRaw)
  if (loRaw !== '' && lo === null) return 'unknown'
  if (hiRaw !== '' && hi === null) return 'unknown'

  if (comma === '' && lo !== null && hi === null) {
    // [1.20.1] 这种精确写法
    return compare(version, lo) === 0 ? 'satisfied' : 'violated'
  }

  if (lo !== null) {
    const c = compare(version, lo)
    if (open === '[' ? c < 0 : c <= 0) return 'violated'
  }
  if (hi !== null) {
    const c = compare(version, hi)
    if (close === ']' ? c > 0 : c >= 0) return 'violated'
  }
  return 'satisfied'
}

const OP_RE = /^(>=|<=|>|<|=)?\s*(.+)$/

/**
 * `~` 和 `^` 是 npm semver 的简写，Fabric 生态里大量使用：
 * - `~1.21`   → `>=1.21.0 <1.22.0`（锁次版本）
 * - `~1.21.1` → `>=1.21.1 <1.22.0`
 * - `^1.21`   → `>=1.21.0 <2.0.0`（锁主版本）
 * - `^0.5.1`  → `>=0.5.1 <0.6.0`（0.x 锁次版本，npm 的约定）
 *
 * 不支持它们会把真实的整合包判成「版本不兼容」——
 * Fabulously Optimized 里 controlify / zoomify 用的就是 `~1.21 <1.21.2`。
 */
function satisfiesTildeCaret(version: number[], token: string): boolean | null {
  const marker = token[0]
  if (marker !== '~' && marker !== '^') return null
  const rest = token.slice(1)
  const parts = parseVersion(rest)
  if (parts === null) return null

  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0

  let lo: number[]
  let hi: number[]
  if (marker === '~') {
    lo = [major, minor, patch]
    hi = [major, minor + 1, 0]
  } else if (major > 0) {
    lo = [major, minor, patch]
    hi = [major + 1, 0, 0]
  } else if (minor > 0) {
    lo = [0, minor, patch]
    hi = [0, minor + 1, 0]
  } else {
    lo = [0, 0, patch]
    hi = [0, 0, patch + 1]
  }
  return compare(version, lo) >= 0 && compare(version, hi) < 0
}

function satisfiesToken(version: number[], token: string, dialect: RangeDialect): boolean | null {
  if (token.startsWith('~') || token.startsWith('^')) {
    return satisfiesTildeCaret(version, token)
  }

  const m = OP_RE.exec(token)
  if (m === null) return null
  const op = m[1]
  const raw = (m[2] ?? '').trim()
  if (raw === '' || raw === '*' || raw === 'x') return true

  // 1.20.x 这种前缀写法：只比较给出的段
  // 注意必须是「整段等于 x」，不能写成 /[xX*]/ ——那样 'next-please' 里的 x 会被当成通配符
  const segments = raw.split('.')
  const hasWildcard = segments.some((s) => s === 'x' || s === 'X' || s === '*')
  if (hasWildcard) {
    for (let i = 0; i < segments.length; i += 1) {
      const p = segments[i]
      if (p === undefined) break
      if (p === 'x' || p === 'X' || p === '*') return true
      if ((version[i] ?? 0) !== Number(p)) return false
    }
    return true
  }

  // Forge 的裸版本号不构成限制——它只是「作者测试过的版本」。
  // 这一步必须在通配符判断之后（`1.12.x` 仍然按前缀比）。
  if (op === undefined && dialect === 'forge') return true

  const target = parseVersion(raw)
  if (target === null) return null
  const c = compare(version, target)
  switch (op) {
    case '>=':
      return c >= 0
    case '>':
      return c > 0
    case '<=':
      return c <= 0
    case '<':
      return c < 0
    default:
      return c === 0
  }
}

export function satisfiesRange(
  version: string,
  range: string,
  dialect: RangeDialect = 'any',
): RangeVerdict {
  const v = parseVersion(version)
  if (v === null) return 'unknown'
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*') return 'satisfied'

  // Maven 风格
  if (/^[[（(]/.test(trimmed)) return satisfiesMaven(v, trimmed)

  // semver：|| 是 OR，空格是 AND
  let sawUnknownGroup = false
  for (const group of trimmed.split('||')) {
    const tokens = group
      .trim()
      .split(/\s+/)
      .filter((t) => t !== '')
    if (tokens.length === 0) continue

    let allOk = true
    let unknown = false
    for (const token of tokens) {
      const r = satisfiesToken(v, token, dialect)
      if (r === null) {
        // 看不动的 token 不中断——同组其他 token 可能已经给出明确的「不满足」
        unknown = true
        continue
      }
      if (!r) {
        allOk = false
        break
      }
    }
    if (!allOk) continue
    if (unknown) {
      sawUnknownGroup = true
      continue
    }
    return 'satisfied'
  }

  // 没有任何一组确定满足：全是看不懂的写法就返回 unknown，
  // 不能当成违规——那会让真实的整合包被误判（这正是 ~1.21 踩过的坑）
  return sawUnknownGroup ? 'unknown' : 'violated'
}
