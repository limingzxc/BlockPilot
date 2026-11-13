/** 资源（assets）下载域事件载荷。 */
export interface AssetsPayloads {
  'assets.tasks': {
    readonly index: string
    readonly keys: number
    readonly unique: number
    readonly totalBytes: number
  }
  'assets.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'assets.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'assets.failed': { readonly file: string; readonly error: string }
}
