/** Quilt 加载器域事件载荷。 */
export interface QuiltPayloads {
  'quilt.loader': { readonly gameVersion: string; readonly loaderVersion: string }
  'quilt.profile': { readonly id: string; readonly libraries: number }
  'quilt.no_hash': { readonly count: number; readonly libs: readonly string[] }
  'quilt.version_json': { readonly path: string }
  'quilt.marker': { readonly path: string }
  'quilt.natives': { readonly extracted: number }
  'quilt.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'quilt.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'quilt.failed': { readonly file: string; readonly error: string }
}
