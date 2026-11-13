/** 实例扫描与整合包读取域事件载荷。 */
import type { LoaderRef } from '../instance.js'

export interface InstancePayloads {
  'instance.scanned': {
    readonly dir: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly skipped: number
  }
  'modpack.reading': { readonly path: string }
  'modpack.parsed': {
    readonly name: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly overridesMods: number
  }
  'modpack.curseforge': {
    readonly name: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly overridesMods: number
  }
}
