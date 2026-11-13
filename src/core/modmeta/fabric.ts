/** fabric.mod.json。 */

import { normDep } from './deps.js'
import { parseModJson } from './json.js'
import type { ModDependency, ModMetadata } from './types.js'

/** Fabric 的 depends 值可能是字符串，也可能是数组（表示 or 关系）。 */
function flattenFabricRange(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' || ')
  return undefined
}

export function fromFabric(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const id = raw.id
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const depends = raw.depends
  if (depends !== null && typeof depends === 'object') {
    for (const [modId, range] of Object.entries(depends as Record<string, unknown>)) {
      deps.push(normDep(modId, true, flattenFabricRange(range)))
    }
  }

  const breaks = raw.breaks
  if (breaks !== null && typeof breaks === 'object') {
    for (const [modId, range] of Object.entries(breaks as Record<string, unknown>)) {
      deps.push(normDep(modId, false, flattenFabricRange(range), 'breaks'))
    }
  }

  const provides: string[] = []
  const rawProvides = raw.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) if (typeof p === 'string') provides.push(p)
  }

  const version = typeof raw.version === 'string' ? raw.version : 'unknown'
  const name = typeof raw.name === 'string' ? raw.name : undefined
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
