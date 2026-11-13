/** 1.12.2 及更早的 mcmod.info。 */

import { normDep } from './deps.js'
import { parseModJson } from './json.js'
import type { ModDependency, ModMetadata } from './types.js'

/** 1.12.2 的 mcmod.info：可能是数组、`{ modList: [...] }`，也可能是单个对象。 */
type McmodEntry = {
  modid?: string
  name?: string
  version?: string
  mcversion?: string
  dependencies?: unknown
}

function mcmodEntries(raw: Record<string, unknown>): McmodEntry[] {
  if (Array.isArray(raw)) return raw as McmodEntry[]
  const list = raw.modList
  if (Array.isArray(list)) return list as McmodEntry[]
  return [raw as McmodEntry]
}

function pickMcmodEntry(raw: Record<string, unknown>): McmodEntry | null {
  return mcmodEntries(raw)[0] ?? null
}

/** mcversion 可能是 `1.12.2`、`1.12`、`1.12.x`，也可能是 `[1.12.2,1.13)`。统一成范围表达式。 */
function asRange(mcversion: string): string {
  const v = mcversion.trim()
  if (/^[[(]/.test(v)) return v
  // 1.12.x / 1.12.* 都是「1.12 这一代」，先去掉通配段再当前缀处理
  const cleaned = v.replace(/\.(x|X|\*)$/, '')
  const parts = cleaned.split('.')
  if (parts.length === 2) {
    const next = Number(parts[1]) + 1
    return `>=${cleaned} <${parts[0]}.${next}`
  }
  return `[${cleaned}]`
}

/**
 * 1.12.2 的依赖写法：`required-after:modid[@[1.0,)]`、`after:modid`、`optional:modid`。
 *
 * 注意：`mcmod.info` 里的 dependencies **不是 Forge 的硬依赖**——真正生效的是
 * `@Mod(dependencies=...)` 注解，这份只是模组列表的展示信息，作者常年不维护。
 * 实证：RLCraft 2.9.3 里 WolfArmor 声明了三个不存在的前置（twilightforest 等），
 * 这个包照样能进游戏。把它们当 required 会让每个 1.12.2 整合包满屏假 blocker。
 *
 * 所以全部记为 non-mandatory：保留信息，不参与「缺没缺」的判定。
 */
function parseForgeDeps(raw: unknown): ModDependency[] {
  if (!Array.isArray(raw)) return []
  const out: ModDependency[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    // 一个数组项就是一条依赖。**不能按逗号切**：`@[1.0,)` 里的逗号是版本范围的一部分，
    // 切完会多出一个叫 ")" 的模组（RLCraft 的 betternether 就是这样）。
    for (const part of item.split(';')) {
      const token = part.trim()
      if (token === '') continue
      const colon = token.indexOf(':')
      const kind = (colon === -1 ? 'required' : token.slice(0, colon)).trim().toLowerCase()
      const rest = colon === -1 ? token : token.slice(colon + 1).trim()
      const at = rest.indexOf('@')
      // Forge 的 modId 一律小写；mcmod.info 里常写成 ForgeEndertech / Forge
      const modId = (at === -1 ? rest : rest.slice(0, at)).trim().toLowerCase()
      const range = at === -1 ? undefined : rest.slice(at + 1).trim()
      if (modId === '') continue
      if (kind === 'before' || kind === 'after' || kind === 'optional') continue
      out.push(normDep(modId, false, range === '' ? undefined : range))
    }
  }
  return out
}

export function fromMcmodInfo(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const entries = mcmodEntries(raw)
  const entry = pickMcmodEntry(raw)
  if (entry === null || typeof entry.modid !== 'string' || entry.modid === '') return null

  // 一个 jar 声明多个 mod 时，主 modId 之外的也要能被依赖匹配上，否则会报假缺前置
  const provides: string[] = []
  for (const extra of entries.slice(1)) {
    if (typeof extra.modid === 'string' && extra.modid !== '' && !provides.includes(extra.modid)) {
      provides.push(extra.modid)
    }
  }

  const deps = parseForgeDeps(entry.dependencies)
  const mc =
    typeof entry.mcversion === 'string' && entry.mcversion !== '' ? entry.mcversion : undefined

  return {
    modId: entry.modid,
    version: typeof entry.version === 'string' ? entry.version : 'unknown',
    ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
    loader: 'forge',
    // mcversion 同样只是展示信息，放进字段供人参考，不升级成 minecraft 依赖
    ...(mc === undefined ? {} : { mcVersionRange: asRange(mc) }),
    dependencies: deps,
    provides,
    nested: [],
  }
}
