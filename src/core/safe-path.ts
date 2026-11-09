/**
 * 路径拼接的唯一入口。
 *
 * 解压 zip / tar / mrpack 时，「条目名 → 落盘路径」这件事在四个地方各写了一遍：
 * `mrpack.ts` 的 `isSafePackPath`、`pack.ts` 与 `install.ts` 的 `name.includes('..')`、
 * `tar.ts`、`vanilla.ts` 的 `extractNatives`。写法不同，漏法也不同。
 *
 * `includes('..')` 还**误杀**合法文件名：`foo..bar.jar` 会被当成穿越而丢掉。
 * 正确做法是按路径段判断，再用 resolve 后的前缀做最后一道校验。
 */

import { resolve, sep } from 'node:path'

/** 条目名是不是实例内 / 解压目标内的相对路径。 */
export function isSafeRelative(rel: string): boolean {
  if (rel === '' || rel === '.') return false
  // POSIX 绝对路径与 Windows 根相对路径
  if (rel.startsWith('/') || rel.startsWith('\\')) return false
  // 盘符路径：C:\x、C:/x
  if (/^[A-Za-z]:/.test(rel)) return false
  // UNC：\\server\share
  if (rel.startsWith('//')) return false
  // 反斜杠也当分隔符：Windows 客户端会把 `..\..\x` 解释成上一级
  return !rel.split(/[\\/]/).some((seg) => seg === '..')
}

/**
 * 把 `rel` 安全地拼到 `base` 下。不安全返回 `null`，调用方跳过该条目。
 *
 * 除了段级检查，还做一次 resolve 后的前缀比较：这是最后一道，防止
 * `base` 本身带符号链接、或出现没预料到的分隔符写法。
 */
export function safeJoin(base: string, rel: string): string | null {
  if (!isSafeRelative(rel)) return null
  const root = resolve(base)
  const out = resolve(root, rel)
  if (out === root) return null
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return out.startsWith(prefix) ? out : null
}
