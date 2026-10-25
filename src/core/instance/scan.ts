import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ModMetadata } from '../modmeta/types.js'
import { readModMetadata } from '../modmeta/read.js'
import type { Instance, LoaderKind, ModRef } from '../instance.js'

export interface ScannedMod {
  readonly fileName: string
  readonly meta: ModMetadata
}

export interface ScanResult {
  readonly instance: Instance
  readonly mods: readonly ScannedMod[]
  /** 读不出元数据的 .jar（资源包、损坏文件、非模组） */
  readonly skipped: readonly string[]
}

export interface ScanOptions {
  /** 目录里没有版本信息时的兜底 */
  readonly fallbackGameVersion: string
  readonly fallbackLoader: { readonly kind: LoaderKind; readonly version: string }
}

interface MmcPack {
  readonly components?: ReadonlyArray<{ readonly uid?: string; readonly version?: string }>
}

const MMC_LOADER_UID: Readonly<Record<string, LoaderKind>> = {
  'net.fabricmc.fabric-loader': 'fabric',
  'org.quiltmc.quilt-loader': 'quilt',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
}

/** 支持 MultiMC / Prism 实例目录、裸 .minecraft、以及任何带 mods/ 的目录。 */
function findModsDir(dir: string): string | null {
  for (const candidate of [join(dir, 'mods'), join(dir, '.minecraft', 'mods')]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return null
}

function readVersionFromMmcPack(dir: string): {
  gameVersion?: string
  loader?: { kind: LoaderKind; version: string }
} {
  const file = join(dir, 'mmc-pack.json')
  if (!existsSync(file)) return {}
  try {
    const pack = JSON.parse(readFileSync(file, 'utf8')) as MmcPack
    const components = pack.components ?? []
    const mc = components.find((c) => c.uid === 'net.minecraft')
    const loaderComp = components.find((c) => c.uid !== undefined && c.uid in MMC_LOADER_UID)
    const kind = loaderComp?.uid === undefined ? undefined : MMC_LOADER_UID[loaderComp.uid]
    return {
      ...(mc?.version === undefined ? {} : { gameVersion: mc.version }),
      ...(kind === undefined
        ? {}
        : { loader: { kind, version: loaderComp?.version ?? 'unknown' } }),
    }
  } catch {
    return {}
  }
}

export function scanInstanceDir(dir: string, opts: ScanOptions): ScanResult {
  const fromPack = readVersionFromMmcPack(dir)
  const gameVersion = fromPack.gameVersion ?? opts.fallbackGameVersion
  const loader = fromPack.loader ?? opts.fallbackLoader

  const modsDir = findModsDir(dir)
  const mods: ScannedMod[] = []
  const skipped: string[] = []
  const refs: ModRef[] = []

  if (modsDir !== null) {
    for (const name of readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      const full = join(modsDir, name)
      if (!statSync(full).isFile()) continue
      let meta: ModMetadata | null = null
      try {
        meta = readModMetadata(new Uint8Array(readFileSync(full)))
      } catch {
        meta = null
      }
      if (meta === null) {
        skipped.push(name)
        continue
      }
      mods.push({ fileName: name, meta })
      refs.push({
        source: 'local',
        modId: meta.modId,
        fileName: `mods/${name}`,
      })
    }
  }

  return {
    instance: {
      id: dir,
      name: dir,
      gameVersion,
      loader,
      mods: refs,
    },
    mods,
    skipped,
  }
}
