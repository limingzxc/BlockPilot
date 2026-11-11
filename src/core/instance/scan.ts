import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Instance, LoaderRef, ModRef } from '../instance.js'
import { isCorruptZip, readModMetadata } from '../modmeta/read.js'
import type { ModMetadata } from '../modmeta/types.js'
import { readInstanceIdentity } from './identity.js'

export interface ScannedMod {
  readonly fileName: string
  readonly meta: ModMetadata
}

export interface ScanResult {
  readonly instance: Instance
  readonly mods: readonly ScannedMod[]
  /** 读不出元数据的 .jar（资源包、损坏文件、非模组） */
  readonly skipped: readonly string[]
  /** skipped 里**结构损坏**的那部分。要删掉重下，不只是「没元数据」 */
  readonly corrupt: readonly string[]
}

export interface ScanOptions {
  /**
   * 目录里没有身份标记时的兜底。
   *
   * 可选：调用方通常不该先知道要扫描出来的身份——`readInstanceIdentity` 会读
   * `mmc-pack.json`；只有 deploy 这种「刚按包写进去」的场景才需要兜底。
   */
  readonly fallbackGameVersion?: string
  readonly fallbackLoader?: LoaderRef
}

/** 支持 MultiMC / Prism 实例目录、裸 .minecraft、以及任何带 mods/ 的目录。 */
function findModsDir(dir: string): string | null {
  for (const candidate of [join(dir, 'mods'), join(dir, '.minecraft', 'mods')]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
  }
  return null
}

/** 1.12.2 及更早的 Forge 用 mcmod.info，1.13+ 用 mods.toml。 */
function isLegacyMinecraft(gameVersion: string): boolean {
  const m = /^1\.(\d+)/.exec(gameVersion)
  return m !== null && Number(m[1]) <= 12
}

export function scanInstanceDir(dir: string, opts: ScanOptions = {}): ScanResult {
  const identity = readInstanceIdentity(dir)
  const gameVersion = identity.gameVersion ?? opts.fallbackGameVersion ?? 'unknown'
  const loader = identity.loader ??
    opts.fallbackLoader ?? { kind: 'vanilla' as const, version: 'unknown' }
  const legacy = isLegacyMinecraft(gameVersion)

  const modsDir = findModsDir(dir)
  const mods: ScannedMod[] = []
  const skipped: string[] = []
  const corrupt: string[] = []
  const refs: ModRef[] = []

  if (modsDir !== null) {
    for (const name of readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      const full = join(modsDir, name)
      if (!statSync(full).isFile()) continue
      let bytes: Uint8Array
      try {
        bytes = readFileSync(full)
      } catch {
        skipped.push(name)
        continue
      }
      let meta: ModMetadata | null = null
      try {
        // 把实例加载器传进去：多加载器 jar 要读对应那一侧的元数据（issue #17）
        meta = readModMetadata(bytes, { legacy, loader: loader.kind })
      } catch {
        meta = null
      }
      if (meta === null) {
        skipped.push(name)
        // 区分「不是模组」和「文件坏了」：后者要删掉重下
        if (isCorruptZip(bytes)) corrupt.push(name)
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
    corrupt,
  }
}
