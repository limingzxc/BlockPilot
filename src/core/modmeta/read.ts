import { strFromU8, unzipSync } from 'fflate'
import { parse as parseToml } from 'smol-toml'

import type { ModDependency, ModLoaderKind, ModMetadata } from './types.js'

const FABRIC = 'fabric.mod.json'
const QUILT = 'quilt.mod.json'
const NEOFORGE = 'META-INF/neoforge.mods.toml'
const FORGE = 'META-INF/mods.toml'

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

function fromFabric(text: string): ModMetadata | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
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
  }
}

function fromQuilt(text: string): ModMetadata | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
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
  }
}

/**
 * 从 jar 的字节里读出模组元数据。
 *
 * 只解压四个候选条目——真实的 mod jar 可能有几千个 class，全解会吃掉时间和内存。
 * 读不出来就返回 null：损坏的 jar、资源包、甚至伪装成 mod 的文件都会走这条路。
 */
export function readModMetadata(jar: Uint8Array): ModMetadata | null {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(jar, {
      filter: (f) => (CANDIDATES as readonly string[]).includes(f.name),
    })
  } catch {
    return null
  }

  if (entries[FABRIC] !== undefined) return fromFabric(strFromU8(entries[FABRIC]))
  if (entries[QUILT] !== undefined) return fromQuilt(strFromU8(entries[QUILT]))
  if (entries[NEOFORGE] !== undefined) return fromForgeToml(strFromU8(entries[NEOFORGE]), 'neoforge')
  if (entries[FORGE] !== undefined) return fromForgeToml(strFromU8(entries[FORGE]), 'forge')
  return null
}
