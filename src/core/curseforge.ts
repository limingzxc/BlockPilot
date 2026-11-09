/**
 * CurseForge 的**契约**（不是实现）。
 *
 * 这些类型以前住在 `src/sources/curseforge.ts`，于是 `core/deploy.ts`、
 * `core/preflight/index.ts`、`core/setup/pack.ts` 都反向 import 了外层实现，
 * 与 ADR-0001「换实现只改 sources/，core 一行不动」相悖。
 *
 * 现在接口、稳定错误码、CF 元数据 → `VersionInfo` 的纯映射留在 core；
 * HTTP 客户端与「有 key 走官方 / 没 key 走镜像」的选择留在 `src/sources/`，
 * 由 CLI / MCP 注入。
 */

import { BlockPilotError } from './errors.js'
import type { DependencyRef, VersionInfo } from './sources.js'

export type CfDependencyRelation = 'required' | 'optional' | 'incompatible' | 'other'

export interface CfDependency {
  readonly modId: number
  readonly relation: CfDependencyRelation
}

export interface CfFileInfo {
  readonly fileId: number
  readonly modId: number
  readonly fileName: string
  readonly displayName: string
  readonly size: number
  /** 作者可以关掉第三方下载，这时是 null */
  readonly downloadUrl: string | null
  readonly hashes: Readonly<Record<string, string>>
  /** CF 的 gameVersions 混着游戏版本与加载器名，如 ["1.12.2", "Forge"] */
  readonly gameVersions: readonly string[]
  readonly dependencies: readonly CfDependency[]
}

/** CF API 的稳定失败码。文案可以改，code 给脚本用。 */
export class CurseforgeError extends BlockPilotError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'CurseforgeError'
  }
}

/** 一个待解析的文件。官方接口只用 fileId，镜像接口两者都要（URL 里带 projectId）。 */
export interface CfFileQuery {
  readonly projectId: number
  readonly fileId: number
}

/** 官方与镜像的共同契约。deploy / preflight 只依赖这个。 */
export interface CurseforgeLike {
  readonly configured: boolean
  /** 日志/署名用，如 `MCIM · mod.mcimirror.top` */
  readonly label: string
  getFiles(
    files: readonly CfFileQuery[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<number, CfFileInfo>>
  /**
   * 反查某个 project 在指定 MC / 加载器下的最新文件。`update` 用。
   *
   * 可选：老实现（测试替身）不提供也不影响 deploy 的按 fileId 解析。
   */
  getLatestFile?(
    projectId: number,
    gameVersion: string,
    loader: string | null,
    signal: AbortSignal,
  ): Promise<CfFileInfo | null>
}

/**
 * 没有注入解析器时的兜底：一律「未配置」。
 *
 * core 不再自己 new 一个实现——那样等于把 sources/ 又依赖回来。CLI / MCP
 * 必须显式注入；测试可以传假实现。没有注入时行为等同于 `--no-cf-mirror`。
 */
export const unconfiguredCurseforge: CurseforgeLike = {
  configured: false,
  label: '未配置',
  getFiles: () => Promise.resolve(new Map<number, CfFileInfo>()),
}

/** CF 的 gameVersions 把加载器和 MC 版本混在一个数组里，这里只认这几种写法。 */
const CF_LOADERS: Readonly<Record<string, string>> = {
  forge: 'forge',
  neoforge: 'neoforge',
  fabric: 'fabric',
  'legacy fabric': 'fabric',
  quilt: 'quilt',
}

/**
 * CF 的文件元数据 → 预检用的 VersionInfo。
 *
 * 两个坑：
 * - `gameVersions` 是混合数组（`["1.12.2","Forge","Java 17"]`），要拆成
 *   「MC 版本」与「加载器」两列，否则 `1.12.2` 会被当成一个加载器名。
 * - 作者没填 gameVersions 的包确实存在。这时**不能**让上层去判版本——
 *   空的声明列表会被读成「不支持任何版本」，直接产出一个假 blocker。
 */
export function cfFileToVersionInfo(info: CfFileInfo): VersionInfo {
  const gameVersions: string[] = []
  const loaders: string[] = []
  for (const v of info.gameVersions) {
    if (/^\d+\.\d+(\.\d+)?$/.test(v)) gameVersions.push(v)
    else {
      const loader = CF_LOADERS[v.toLowerCase()]
      if (loader !== undefined && !loaders.includes(loader)) loaders.push(loader)
    }
  }

  const dependencies: DependencyRef[] = []
  for (const d of info.dependencies) {
    if (d.relation !== 'required' && d.relation !== 'incompatible') continue
    dependencies.push({ projectId: String(d.modId), versionId: null, kind: d.relation })
  }

  return {
    projectId: String(info.modId),
    versionId: String(info.fileId),
    name: info.displayName,
    gameVersions,
    loaders,
    dependencies,
    files: [
      {
        url: info.downloadUrl ?? '',
        filename: info.fileName,
        size: info.size,
        primary: true,
        hashes: info.hashes,
      },
    ],
  }
}
