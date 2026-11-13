/**
 * 加载器安装的共享类型。
 *
 * 这些类型原来和分派表一起住在 `loader.ts`，于是 fabric / forge / quilt / profile
 * 都要反向 import 分派器，形成 `loader → adapter → loader` 的文件级环。
 * 类型单独放一份，adapter 只依赖契约，`loader.ts` 只做分派。
 */

import type { Mirror } from '../download/types.js'
import type { Operation } from '../events/operation.js'
import type { LoaderKind } from '../instance.js'
import type { Layout } from '../layout.js'

export interface LoaderInstallOptions {
  readonly kind: LoaderKind
  readonly layout: Layout
  readonly gameVersion: string
  /** 不填则由各加载器取最新兼容版 */
  readonly loaderVersion?: string
  /** 只有 Forge / NeoForge 要：跑 installer 的 java */
  readonly java?: string
  /** installer 的下载走这个代理 */
  readonly proxy?: string
  /** 元数据与文件走国内镜像 */
  readonly mirror?: boolean
  /** 只有 Fabric 用：强制 Legacy Fabric */
  readonly legacy?: boolean
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
  /**
   * 分派注入点，测试用。
   *
   * 真实实现由分派表决定；测试传假的 Operation 就能离线验证「哪些 kind 走 profile、
   * 哪些走 installer」，不用下载任何东西。
   */
  readonly deps?: LoaderInstallDeps
}

export interface LoaderInstallDeps {
  readonly profile?: (options: LoaderInstallOptions) => Operation<LoaderInstallResult>
  readonly installer?: (options: LoaderInstallOptions) => Operation<LoaderInstallResult>
}

/** 下载 profile 库的加载器（Fabric / Quilt）才有的计数。 */
export interface ProfileLoaderDetail {
  readonly kind: 'profile'
  readonly libraries: number
  readonly downloaded: number
  readonly skipped: number
  readonly nativesExtracted: number
}

/** 跑官方 installer 的加载器（Forge / NeoForge）才有的信息。 */
export interface InstallerLoaderDetail {
  readonly kind: 'installer'
  readonly installerRan: boolean
}

export interface LoaderInstallResult {
  readonly versionId: string
  /** 实际装上的 loader 版本，写进 lock 与 mmc-pack.json 的就是它 */
  readonly loaderVersion: string
  readonly versionJsonPath: string
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly detail: ProfileLoaderDetail | InstallerLoaderDetail
}
