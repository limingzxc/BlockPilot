/**
 * CurseForge 整合包（zip + manifest.json）的解析。
 *
 * 格式参考（GDLauncher 文档与真实包）：
 *
 *   {
 *     "minecraft": { "version": "1.20.1",
 *                    "modLoaders": [{ "id": "forge-47.2.0", "primary": true }] },
 *     "manifestType": "minecraftModpack",
 *     "manifestVersion": 1,
 *     "name": "...", "version": "...", "author": "...",
 *     "files": [{ "projectID": 238222, "fileID": 5246076, "required": true }],
 *     "overrides": "overrides"
 *   }
 *
 * 与 .mrpack 的本质差异：CF 的 files 只有 projectID/fileID 两个数字，
 * **没有 URL 也没有哈希**——下载与校验都必须调 CurseForge 的 API（要 key）。
 * 所以这一层能做的只有：读出 MC 版本、加载器、文件数，然后如实报告
 * 「mod 级别的校验做不了」。把没 key 硬装说成支持，是骗人。
 */

import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'

import type { Instance, LoaderKind, ModRef } from '../instance.js'

const MANIFEST_ENTRY = 'manifest.json'

export interface CurseforgeFile {
  readonly projectID: number
  readonly fileID: number
  readonly required?: boolean
}

export interface CurseforgeManifest {
  readonly manifestType?: string
  readonly manifestVersion?: number
  readonly name?: string
  readonly version?: string
  readonly author?: string
  readonly minecraft: {
    readonly version: string
    readonly modLoaders?: readonly {
      readonly id: string
      readonly primary?: boolean
    }[]
  }
  readonly files: readonly CurseforgeFile[]
  readonly overrides?: string
}

export interface CurseforgePack {
  readonly manifest: CurseforgeManifest
  readonly instance: Instance
  /** files 里 required !== false 的数量 */
  readonly requiredCount: number
}

/** 只解压 manifest 一个条目——CF 包的 overrides 可能上百 MB。 */
export function readCurseforgeManifest(zipPath: string, data?: Uint8Array): CurseforgeManifest {
  const entries = unzipSync(data ?? new Uint8Array(readFileSync(zipPath)), {
    filter: (f) => f.name === MANIFEST_ENTRY,
  })
  const buf = entries[MANIFEST_ENTRY]
  if (buf === undefined) {
    throw new Error(`不是 CurseForge 整合包：zip 里没有 ${MANIFEST_ENTRY}`)
  }
  return JSON.parse(strFromU8(buf)) as CurseforgeManifest
}

/**
 * loader 的 id 是 `{kind}-{version}`，kind 的大小写不统一：
 * 真实包里见过 `forge-47.2.0`、`fabric-0.15.3`、`NeoForge-47.1.106`。
 * 所以按第一个 `-` 切，kind 一律小写。version 是剩下的全部——
 * Forge 的版本号自己就带 `-`（如 `1.20.1-47.2.0` 的旧写法），不能按 `-` 全切。
 *
 * 认不出的 kind 返回 vanilla 而不是硬套：LoaderKind 没有更好的占位，
 * 而「mod 级校验做不了」的提示反正会覆盖这种情况。
 */
export function parseLoaderId(id: string): { kind: LoaderKind; version: string } {
  const cut = id.indexOf('-')
  const kindRaw = cut === -1 ? id : id.slice(0, cut)
  const version = cut === -1 ? 'unknown' : id.slice(cut + 1)
  const kind = kindRaw.toLowerCase()
  if (kind === 'forge' || kind === 'fabric' || kind === 'neoforge' || kind === 'quilt') {
    return { kind, version }
  }
  return { kind: 'vanilla', version }
}

export function curseforgeToInstance(manifest: CurseforgeManifest): Instance {
  const mc = manifest.minecraft
  const primary = mc.modLoaders?.find((l) => l.primary === true) ?? mc.modLoaders?.[0]
  const loader =
    primary !== undefined
      ? parseLoaderId(primary.id)
      : { kind: 'vanilla' as const, version: 'unknown' }

  const mods: ModRef[] = manifest.files
    .filter((f) => f.required !== false)
    .map((f) => ({
      source: 'curseforge' as const,
      projectId: String(f.projectID),
      versionId: String(f.fileID),
      fileName: `project-${f.projectID}-file-${f.fileID}`,
    }))

  return {
    id: manifest.name ?? 'curseforge-pack',
    name: manifest.name ?? 'CurseForge modpack',
    gameVersion: mc.version,
    loader,
    mods,
  }
}

/** zip 里是不是 CF 整合包。先探测再解析，避免把普通 zip 当成包。 */
export function isCurseforgeZip(zipPath: string): boolean {
  try {
    const manifest = readCurseforgeManifest(zipPath)
    return manifest.manifestType === 'minecraftModpack'
  } catch {
    return false
  }
}

export function readCurseforgePack(zipPath: string, data?: Uint8Array): CurseforgePack {
  const manifest = readCurseforgeManifest(zipPath, data)
  if (manifest.manifestType !== 'minecraftModpack') {
    throw new Error(`manifestType 不是 minecraftModpack：${String(manifest.manifestType)}`)
  }
  const instance = curseforgeToInstance(manifest)
  const requiredCount = instance.mods.length
  return { manifest, instance, requiredCount }
}
