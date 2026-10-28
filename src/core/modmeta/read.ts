import { strFromU8, unzipSync } from 'fflate'
import { parse as parseToml } from 'smol-toml'

import type { ModDependency, ModLoaderKind, ModMetadata } from './types.js'

const FABRIC = 'fabric.mod.json'
const QUILT = 'quilt.mod.json'
const NEOFORGE = 'META-INF/neoforge.mods.toml'
const FORGE = 'META-INF/mods.toml'
/** Fabric 用 JiJ（jars/），Forge 用 JarJar（jarjar/）。两套前缀都要扫。 */
const JIJ_PREFIXES = ['META-INF/jars/', 'META-INF/jarjar/'] as const

function isNestedJar(name: string): boolean {
  return JIJ_PREFIXES.some((p) => name.startsWith(p)) && name.endsWith('.jar')
}

/** 按加载器优先级排列。多加载器 jar 里 fabric 声明通常最准确。 */
const CANDIDATES = [FABRIC, QUILT, NEOFORGE, FORGE] as const

type TomlShape = {
  modLoader?: string
  loaderVersion?: string
  mods?: Array<{ modId?: string; version?: string; displayName?: string }>
  dependencies?: Record<
    string,
    Array<{ modId?: string; mandatory?: boolean; versionRange?: string }>
  >
}

function normDep(modId: string, mandatory: boolean, range?: string): ModDependency {
  return { modId, mandatory, ...(range === undefined || range === '' ? {} : { versionRange: range }) }
}

/** Fabric 的 depends 值可能是字符串，也可能是数组（表示 or 关系）。 */
function flattenFabricRange(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' || ')
  return undefined
}

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
function parseModJson(text: string): Record<string, unknown> | null {
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

function fromFabric(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const id = raw['id']
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const depends = raw['depends']
  if (depends !== null && typeof depends === 'object') {
    for (const [modId, range] of Object.entries(depends as Record<string, unknown>)) {
      deps.push(normDep(modId, true, flattenFabricRange(range)))
    }
  }

  const provides: string[] = []
  const rawProvides = raw['provides']
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) if (typeof p === 'string') provides.push(p)
  }

  const version = typeof raw['version'] === 'string' ? raw['version'] : 'unknown'
  const name = typeof raw['name'] === 'string' ? raw['name'] : undefined
  const mc = deps.find((d) => d.modId === 'minecraft')
  const fl = deps.find((d) => d.modId === 'fabricloader')

  return {
    modId: id,
    version,
    ...(name === undefined ? {} : { name }),
    loader: 'fabric',
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    ...(fl?.versionRange === undefined ? {} : { loaderVersionRange: fl.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
  }
}

function fromQuilt(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const ql = raw['quilt_loader']
  if (ql === null || typeof ql !== 'object') return null
  const node = ql as Record<string, unknown>
  const id = node['id']
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const rawDeps = node['depends']
  if (Array.isArray(rawDeps)) {
    for (const d of rawDeps) {
      if (d !== null && typeof d === 'object') {
        const item = d as Record<string, unknown>
        const depId = item['id']
        if (typeof depId === 'string') {
          const versions = item['versions']
          deps.push(normDep(depId, true, typeof versions === 'string' ? versions : undefined))
        }
      }
    }
  }

  const version = typeof node['version'] === 'string' ? node['version'] : 'unknown'
  const mc = deps.find((d) => d.modId === 'minecraft')

  const provides: string[] = []
  const rawProvides = node['provides']
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) {
      if (p !== null && typeof p === 'object') {
        const pid = (p as Record<string, unknown>)['id']
        if (typeof pid === 'string') provides.push(pid)
      }
    }
  }

  return {
    modId: id,
    version,
    loader: 'quilt',
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
  }
}

function fromForgeToml(text: string, loader: ModLoaderKind): ModMetadata | null {
  let raw: TomlShape
  try {
    raw = parseToml(text) as TomlShape
  } catch {
    return null
  }
  const first = raw.mods?.[0]
  if (first === undefined || typeof first.modId !== 'string') return null

  const depsRaw = raw.dependencies?.[first.modId] ?? []
  const deps: ModDependency[] = []
  for (const d of depsRaw) {
    if (typeof d.modId !== 'string') continue
    deps.push(normDep(d.modId, d.mandatory !== false, d.versionRange))
  }

  const mc = deps.find((d) => d.modId === 'minecraft')
  const fl = deps.find((d) => d.modId === 'forge' || d.modId === 'neoforge')

  return {
    modId: first.modId,
    version: typeof first.version === 'string' ? first.version : 'unknown',
    ...(first.displayName === undefined ? {} : { name: first.displayName }),
    loader,
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    ...(fl?.versionRange === undefined ? {} : { loaderVersionRange: fl.versionRange }),
    dependencies: deps,
    // Forge 没有 provides 概念，子模块用 jar-in-jar 解决
    provides: [],
    nested: [],
  }
}

/** 读 `META-INF/jars/*.jar` 里的嵌套模组。Fabric API 的 57 个子模块都在这里。 */
function readNestedJars(entries: Record<string, Uint8Array>): { modId: string; version: string }[] {
  const out: { modId: string; version: string }[] = []
  for (const [name, data] of Object.entries(entries)) {
    if (!isNestedJar(name)) continue
    try {
      // 嵌套 jar 可能是 Fabric 风格（fabric.mod.json）或 Forge 风格（mods.toml）
      const inner = unzipSync(data, {
        filter: (f) => f.name === FABRIC || f.name === FORGE,
      })

      const fabricBuf = inner[FABRIC]
      if (fabricBuf !== undefined) {
        const parsed = parseModJson(strFromU8(fabricBuf))
        if (parsed !== null && typeof parsed['id'] === 'string' && parsed['id'] !== '') {
          out.push({
            modId: parsed['id'],
            version: typeof parsed['version'] === 'string' ? parsed['version'] : 'unknown',
          })
        }
        continue
      }

      const forgeBuf = inner[FORGE]
      if (forgeBuf !== undefined) {
        const parsed = parseToml(strFromU8(forgeBuf)) as TomlShape
        const first = parsed.mods?.[0]
        if (first?.modId !== undefined && first.modId !== '') {
          out.push({
            modId: first.modId,
            version: typeof first.version === 'string' ? first.version : 'unknown',
          })
        }
      }
    } catch {
      // 嵌套 jar 坏了不影响主 jar 的元数据
    }
  }
  return out
}

/**
 * 从 jar 的字节里读出模组元数据。
 *
 * 只解压四个候选条目和 `META-INF/jars/*.jar`——真实的 mod jar 可能有几千个 class，
 * 全解会吃掉时间和内存。读不出来就返回 null：损坏的 jar、资源包、
 * 甚至伪装成 mod 的文件都会走这条路。
 */
export function readModMetadata(jar: Uint8Array): ModMetadata | null {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(jar, {
      filter: (f) =>
        (CANDIDATES as readonly string[]).includes(f.name) ||
        isNestedJar(f.name),
    })
  } catch {
    return null
  }

  const nested = readNestedJars(entries)
  const withNested = (meta: ModMetadata | null): ModMetadata | null =>
    meta === null ? null : { ...meta, nested }

  if (entries[FABRIC] !== undefined) return withNested(fromFabric(strFromU8(entries[FABRIC])))
  if (entries[QUILT] !== undefined) return withNested(fromQuilt(strFromU8(entries[QUILT])))
  if (entries[NEOFORGE] !== undefined)
    return withNested(fromForgeToml(strFromU8(entries[NEOFORGE]), 'neoforge'))
  if (entries[FORGE] !== undefined) return withNested(fromForgeToml(strFromU8(entries[FORGE]), 'forge'))
  return null
}
