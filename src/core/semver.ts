/**
 * 够用的版本范围判断。
 *
 * 两套语法都要支持，因为同一份实例里两种 mod 都有：
 * - Fabric 用 semver 表达式：`>=0.16.10`、`>=1.20.1 <1.21`、`1.20.x`
 * - Forge 用 Maven 范围：`[1.20.1,1.21)`、`[0.6.10,)`
 *
 * 刻意不追求完整：不处理预发布标签（`1.0.0-beta.1`）的排序、
 * 不处理 `~` / `^`（Fabric 生态里很少用）。遇到不认识的写法一律返回
 * `'unknown'`，让调用方决定是忽略还是提示，而不是猜一个答案。
 */

export type RangeVerdict = 'satisfied' | 'violated' | 'unknown'

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

function satisfiesToken(version: number[], token: string): boolean | null {
  const m = OP_RE.exec(token)
  if (m === null) return null
  const op = m[1] ?? '='
  const raw = (m[2] ?? '').trim()
  if (raw === '' || raw === '*' || raw === 'x') return true

  // 1.20.x 这种前缀写法：只比较给出的段
  if (/[xX*]/.test(raw)) {
    const parts = raw.split('.')
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i]
      if (p === undefined) break
      if (p === 'x' || p === 'X' || p === '*') return true
      if ((version[i] ?? 0) !== Number(p)) return false
    }
    return true
  }

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

export function satisfiesRange(version: string, range: string): RangeVerdict {
  const v = parseVersion(version)
  if (v === null) return 'unknown'
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*') return 'satisfied'

  // Maven 风格
  if (/^[[（(]/.test(trimmed)) return satisfiesMaven(v, trimmed)

  // semver：|| 是 OR，空格是 AND
  for (const group of trimmed.split('||')) {
    const tokens = group.trim().split(/\s+/).filter((t) => t !== '')
    if (tokens.length === 0) continue
    let allOk = true
    let anyUnknown = false
    for (const token of tokens) {
      const r = satisfiesToken(v, token)
      if (r === null) {
        anyUnknown = true
        break
      }
      if (!r) {
        allOk = false
        break
      }
    }
    if (allOk && !anyUnknown) return 'satisfied'
  }
  return 'violated'
}
