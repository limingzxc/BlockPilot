/**
 * deploy 的对外契约。
 *
 * 类型与编排分开放：`index.ts` 只保留「按顺序跑哪几步」，
 * 参数/结果的形状在这里演进，不会和流程混在一个文件里。
 */
import type { CfFileInfo, CurseforgeLike } from '../curseforge.js'
import type { Mirror } from '../download/types.js'
import type { Operation } from '../events/operation.js'
import type { HostProfile, LoaderKind } from '../instance.js'
import type { Layout } from '../layout.js'
import type { PackFileRead } from '../pack/index.js'
import type { ReportStats } from '../preflight/report.js'
import type { Finding, Verdict } from '../preflight/types.js'

export interface DeployOptions {
  readonly packPath: string
  /** 已经读过的包。CLI 先读它拿游戏版本/加载器，不必在这里再解一遍 zip */
  readonly pack?: PackFileRead
  readonly layout: Layout
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
  /** 跑 Forge installer 用的 java。Fabric 不需要 */
  readonly java?: string
  /** installer 的下载走这个代理。不填用环境变量 */
  readonly proxy?: string
  /** 元数据与文件都走国内镜像（CLI 的 --china） */
  readonly mirror?: boolean
  /**
   * CurseForge 解析器。缺省按「有 key 走官方、没有走镜像」自动选
   * （见 resolveCurseforge）。测试可注入假实现。
   */
  readonly curseforge?: CurseforgeLike
  /**
   * mrpack 清单里额外放行的下载域名（`--allow-host`）。
   *
   * Modrinth 规范只允许 cdn.modrinth.com / github.com / raw.githubusercontent.com /
   * gitlab.com。本地服务测试与私有镜像用这个显式放行，默认不放宽。
   */
  readonly allowHosts?: readonly string[]
  /**
   * 重跑 deploy 时覆盖 overrides 里已存在的文件（`--overwrite-overrides`）。
   *
   * 缺省跳过：ADR-0012 承诺「重跑是安全的」，而覆盖会冲掉用户改过的 config/ 与 options.txt。
   */
  readonly overwriteOverrides?: boolean
  /**
   * 本机环境。给了就在部署后自检里查 Java；不给就只检查模组与 assets。
   *
   * 没有这个字段，自检**结构上不可能**发现 Java 不对：
   * 装完打「通过」，`run` 紧接着因为 Java 版本死掉。见 ADR-0037。
   */
  readonly host?: HostProfile
  /**
   * 步骤工厂，注入点。缺省用真实的 setup modules。
   * 测试传假的 Operation 就能离线验证编排契约，不用下载任何东西。
   */
  readonly deps?: DeployDeps
}

/** 加载器步骤的契约：result.versionId 就是装完能启动的版本 id。 */
export interface LoaderStepResult {
  readonly versionId: string
}

export interface VanillaStepOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources: readonly Mirror[]
  readonly concurrency: number
}

export interface LoaderStepOptions {
  readonly layout: Layout
  readonly gameVersion: string
  readonly kind: LoaderKind
  readonly loaderVersion: string
  readonly java?: string
  readonly proxy?: string
  readonly mirror?: boolean
  readonly sources: readonly Mirror[]
  readonly concurrency: number
}

export interface DeployDeps {
  /** 原版文件步骤：产出一个 result 即视为成功 */
  readonly vanilla?: (opts: VanillaStepOptions) => Operation<unknown>
  readonly loader?: (opts: LoaderStepOptions) => Operation<LoaderStepResult>
}

export interface DeployResult {
  readonly packName: string
  readonly gameVersion: string
  readonly loaderKind: LoaderKind
  readonly loaderVersion: string
  /** 装完之后用来启动的版本 id */
  readonly playableVersionId: string
  /** 清单里要下载的文件总数（模组、资源包、光影……） */
  readonly files: number
  /** 其中落在 mods/ 下的个数。整合包常带资源包，两个数不该混着报 */
  readonly mods: number
  readonly modsDownloaded: number
  readonly modsSkipped: number
  readonly overrides: number
  /** overrides 里因为已存在而跳过的文件数。非 0 说明这次重跑保留了用户改动 */
  readonly overridesSkipped: number
  /** 已装内容清单的落盘路径。写失败时没有这个字段 */
  readonly lockPath?: string
  /** overrides 里直接塞的 jar 数：这些不受 API key 限制，装完就在 mods/ 里 */
  readonly overridesMods: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  /** 部署后的自检结果。非 ok 就说明装完也起不来 */
  readonly check: {
    readonly verdict: Verdict
    readonly findings: readonly Finding[]
    /** 和 `preflight <实例目录>` 报的是同一份计数：resolved 校验过，unresolved 没校验到 */
    readonly stats: ReportStats
  }
}

/** 供 source-tasks 复用的 CurseForge 解析结果形状。 */
export type CurseforgeFiles = ReadonlyMap<number, CfFileInfo>
