import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

import type { Instance, LoaderKind, ModRef, Side } from '../instance.js'

/** .mrpack 规范：https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack */

export interface MrpackFile {
  readonly path: string
  readonly hashes: Readonly<Record<string, string>>
  readonly env?: { readonly client?: Side; readonly server?: Side }
  readonly downloads: readonly string[]
  readonly fileSize: number
}

export interface MrpackIndex {
  readonly formatVersion: number
  readonly game: string
  readonly versionId: string
  readonly name: string
  readonly files: readonly MrpackFile[]
  readonly dependencies: Readonly<Record<string, string>>
}

const INDEX_ENTRY = 'modrinth.index.json'

/** 只解压 index 一个条目——大整合包有几千个模组，全解会吃掉内存。 */
export function readMrpackIndex(zipPath: string): MrpackIndex {
  const raw = readFileSync(zipPath)
  const entries = unzipSync(new Uint8Array(raw), {
    filter: (f) => f.name === INDEX_ENTRY,
  })
  const buf = entries[INDEX_ENTRY]
  if (!buf) throw new Error(`not a valid mrpack: ${INDEX_ENTRY} not found`)
  return JSON.parse(strFromU8(buf)) as MrpackIndex
}

/** https://cdn.modrinth.com/data/{projectId}/versions/{versionId}/{filename} */
const CDN_RE = /\/data\/([A-Za-z0-9]+)\/versions\/([A-Za-z0-9]+)\//

export function parseModrinthCdnUrl(url: string): { projectId: string; versionId: string } | null {
  const m = CDN_RE.exec(url)
  if (!m) return null
  const [, projectId, versionId] = m
  if (!projectId || !versionId) return null
  return { projectId, versionId }
}

const LOADER_KEY: Readonly<Record<string, LoaderKind>> = {
  'fabric-loader': 'fabric',
  forge: 'forge',
  neoforge: 'neoforge',
  'quilt-loader': 'quilt',
}

export function mrpackToInstance(index: MrpackIndex, id = index.versionId): Instance {
  const deps = index.dependencies
  const loaderEntry = Object.entries(LOADER_KEY).find(([k]) => k in deps)
  const loader = loaderEntry
    ? { kind: loaderEntry[1], version: deps[loaderEntry[0]] ?? 'unknown' }
    : { kind: 'vanilla' as const, version: deps['minecraft'] ?? 'unknown' }

  const mods: ModRef[] = index.files
    .filter((f) => f.path.startsWith('mods/'))
    .map((f) => {
      const url = f.downloads[0]
      const parsed = url ? parseModrinthCdnUrl(url) : null
      return {
        ...(parsed ? { projectId: parsed.projectId, versionId: parsed.versionId } : {}),
        source: parsed ? ('modrinth' as const) : ('local' as const),
        fileName: f.path,
        ...(f.env?.client ? { client: f.env.client } : {}),
        ...(f.env?.server ? { server: f.env.server } : {}),
      }
    })

  return {
    id,
    name: index.name,
    gameVersion: deps['minecraft'] ?? 'unknown',
    loader,
    mods,
  }
}
