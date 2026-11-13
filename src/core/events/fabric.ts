/** Fabric 加载器域事件载荷。 */
export interface FabricPayloads {
  'fabric.legacy': { readonly gameVersion: string }
  'fabric.loader': {
    readonly gameVersion: string
    readonly loaderVersion: string
    readonly flavor: 'official' | 'legacy'
  }
  'fabric.profile': { readonly id: string; readonly libraries: number }
  'fabric.no_hash': { readonly count: number; readonly libs: readonly string[] }
  'fabric.version_json': { readonly path: string }
  'fabric.marker': { readonly path: string }
  'fabric.natives': { readonly extracted: number }
  'fabric.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'fabric.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'fabric.failed': { readonly file: string; readonly error: string }
}
