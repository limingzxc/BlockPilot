import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'

import type { Instance, LoaderKind, ModRef, Side } from '../instance.js'
import { isSafeRelative } from '../safe-path.js'

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

/**
 * 清单结构校验。
 *
 * 以前这里直接 `as MrpackIndex`，于是缺字段时抛的是 JS 内部错误：
 * `TypeError: Cannot use 'in' operator to search for 'fabric-loader' in undefined`。
 * 整合包作者看到这句话，不知道自己少写了 `dependencies`。
 */
function assertMrpackIndex(raw: unknown): MrpackIndex {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('清单不是 JSON 对象')
  }
  const o = raw as Record<string, unknown>

  const version = o.formatVersion
  if (typeof version !== 'number') throw new Error('清单缺少 formatVersion')
  // 不认的格式不能假装看懂了：字段语义可能变，静默通过等于给了个假结论
  if (version !== 1) throw new Error(`不支持的清单格式版本 ${version}（本程序只认 1）`)

  const deps = o.dependencies
  if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
    throw new Error('清单缺少 dependencies 对象')
  }
  if (typeof (deps as Record<string, unknown>).minecraft !== 'string') {
    throw new Error('dependencies 里没有 minecraft 版本')
  }

  const files = o.files
  if (!Array.isArray(files)) throw new Error('清单缺少 files 数组')

  for (let i = 0; i < files.length; i += 1) {
    const entry: unknown = files[i]
    if (typeof entry !== 'object' || entry === null) throw new Error(`files[${i}] 不是对象`)
    const file = entry as Record<string, unknown>

    const p = file.path
    if (typeof p !== 'string' || p === '') throw new Error(`files[${i}] 缺少 path`)
    if (!isSafeRelative(p)) {
      throw new Error(`files[${i}] 的路径不安全：${p}（必须是实例内的相对路径，不能含 .. 或盘符）`)
    }
    if (!Array.isArray(file.downloads)) {
      throw new Error(`files[${i}]（${p}）缺少 downloads 数组`)
    }
    // 缺 hashes 时以前会一路走到 pickAlgo 抛 TypeError，又变成「JS 内部错误」
    if (typeof file.hashes !== 'object' || file.hashes === null || Array.isArray(file.hashes)) {
      throw new Error(`files[${i}]（${p}）缺少 hashes 对象`)
    }
  }

  return o as unknown as MrpackIndex
}

/**
 * 只解压 index 一个条目——大整合包有几千个模组，全解会吃掉内存。
 *
 * `data` 允许调用方复用已经读入的 zip 字节，避免同一文件被 `readFileSync` 多次。
 */
export function readMrpackIndex(zipPath: string, data?: Uint8Array): MrpackIndex {
  const raw = data ?? readFileSync(zipPath)
  const entries = unzipSync(raw, {
    filter: (f) => f.name === INDEX_ENTRY,
  })
  const buf = entries[INDEX_ENTRY]
  if (!buf) throw new Error(`not a valid mrpack: ${INDEX_ENTRY} not found`)

  let parsed: unknown
  try {
    parsed = JSON.parse(strFromU8(buf))
  } catch {
    // 原文会带 "at position 2 (line 1 column 3)"，对写包的人没有帮助
    throw new Error(`${INDEX_ENTRY} 不是合法 JSON`)
  }
  return assertMrpackIndex(parsed)
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
    : { kind: 'vanilla' as const, version: deps.minecraft ?? 'unknown' }

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
    gameVersion: deps.minecraft ?? 'unknown',
    loader,
    mods,
  }
}
