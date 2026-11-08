/**
 * Modpack 读取 seam（架构评审候选 6）。
 *
 * 「target 路径 → Instance + 这个格式能做什么」此前在两个 Operation 里各写一遍：
 * preflight 三分支自己判断格式、自己发日志、自己设统计；deploy 又独立实现
 * 「CF 拦截 + mrpack 解析 + UNSUPPORTED_LOADER」。同一约束（CF 需要 API key）
 * 甚至有两个稳定机器码（CF_API_REQUIRED / CF_API_KEY_REQUIRED），消费者无法统一匹配。
 *
 * 三个 adapter 已经存在（mrpack / CurseForge / 目录扫描），seam 是真实的。
 * 目录扫描不进这个 module：它返回的不是 Instance 而是 ScannedMod 明细，
 * 那是 preflight 离线检查的输入，与「整合包文件」是两件事。
 */
import type { Instance } from '../instance.js'
import { mrpackToInstance, readMrpackIndex } from './mrpack.js'
import type { MrpackIndex } from './mrpack.js'
import { readCurseforgePack } from './curseforge.js'
import type { CurseforgeManifest } from './curseforge.js'
import { countOverridesMods } from '../setup/pack.js'

export type PackFileKind = 'mrpack' | 'curseforge'

export interface PackAbility {
  /** 清单里有没有下载地址。false = 装它需要额外凭据，见 ADR-0021 */
  readonly givesDownloadUrls: boolean
  /** 能不能在没有网络元数据的情况下校验 mod 级信息 */
  readonly checksMods: boolean
}

export interface PackFileRead {
  readonly kind: PackFileKind
  readonly instance: Instance
  readonly ability: PackAbility
  /** mrpack 才有：CF 的文件清单只有 projectID/fileID，没有 URL */
  readonly mrpackIndex?: MrpackIndex
  /** CurseForge 才有：deploy 要拿它的 files 去换下载地址 */
  readonly curseforgeManifest?: CurseforgeManifest
  /**
   * overrides/mods 里的 jar 数。它们不需要 API key、解压后直接进 mods/，
   * 但不算在清单里——不单独报出来，「271 个模组」和日志里的「Loading 304 mods」对不上。
   */
  readonly overridesMods: number
}

/**
 * 读一个整合包文件。两种格式都读不出就抛错（调用方转成 BAD_MODPACK）。
 *
 * 先试 mrpack 再试 CurseForge：mrpack 的 index 是固定文件名，CF 要解 manifest
 * 并校验 manifestType，前者更便宜。
 */
export function readPackFile(path: string): PackFileRead {
  let mrpackError: unknown
  try {
    const index = readMrpackIndex(path)
    const instance = mrpackToInstance(index)
    return {
      kind: 'mrpack',
      instance,
      ability: { givesDownloadUrls: true, checksMods: true },
      mrpackIndex: index,
      overridesMods: countOverridesMods(path),
    }
  } catch (err) {
    mrpackError = err
  }

  try {
    const pack = readCurseforgePack(path)
    return {
      kind: 'curseforge',
      instance: pack.instance,
      ability: { givesDownloadUrls: false, checksMods: false },
      curseforgeManifest: pack.manifest,
      overridesMods: countOverridesMods(path),
    }
  } catch {
    throw new Error(
      `无法解析整合包：${mrpackError instanceof Error ? mrpackError.message : String(mrpackError)}`,
    )
  }
}
