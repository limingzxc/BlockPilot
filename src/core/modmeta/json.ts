/** mod 元数据 JSON 的宽松解析。 */

/**
 * 把字符串字面量里的裸控制字符转义。
 *
 * 真实模组里确实存在这种文件：description 写成多行，换行直接落在 JSON 字符串里。
 * 严格 JSON 不允许，但 Fabric 用的是 Gson（lenient），游戏里能正常加载。
 * 我们只做这一处修补——不实现完整的宽松解析器，避免把坏文件「修」成另一个意思。
 */
function escapeControlCharsInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inString = false
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * 解析 mod 元数据里的 JSON。先按严格标准来，失败再放过裸控制字符。
 *
 * 不这么做的话，`fabric.mod.json` 里一个换行就让整个模组从检查里消失——
 * 用户看到的是「读不出元数据」，看不到的是「这个模组再也不会被检查」。
 */
export function parseModJson(text: string): Record<string, unknown> | null {
  const trimmed = text.replace(/^\uFEFF/, '')
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    // fallthrough：Fabric 的解析器比 JSON.parse 宽松
  }
  try {
    return JSON.parse(escapeControlCharsInStrings(trimmed)) as Record<string, unknown>
  } catch {
    return null
  }
}
