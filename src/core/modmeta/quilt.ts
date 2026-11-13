/** quilt.mod.json。 */

import { normDep } from './deps.js'
import { parseModJson } from './json.js'
import type { ModDependency, ModMetadata } from './types.js'

export function fromQuilt(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const ql = raw.quilt_loader
  if (ql === null || typeof ql !== 'object') return null
  const node = ql as Record<string, unknown>
  const id = node.id
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const rawDeps = node.depends
  if (Array.isArray(rawDeps)) {
    for (const d of rawDeps) {
      if (d !== null && typeof d === 'object') {
        const item = d as Record<string, unknown>
        const depId = item.id
        if (typeof depId === 'string') {
          const versions = item.versions
          deps.push(normDep(depId, true, typeof versions === 'string' ? versions : undefined))
        }
      }
    }
  }

  const version = typeof node.version === 'string' ? node.version : 'unknown'
  const mc = deps.find((d) => d.modId === 'minecraft')

  const provides: string[] = []
  const rawProvides = node.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) {
      if (p !== null && typeof p === 'object') {
        const pid = (p as Record<string, unknown>).id
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
