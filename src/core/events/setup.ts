/** 原版 setup 域事件载荷。 */
export interface SetupPayloads {
  'setup.tasks': {
    readonly tasks: number
    readonly totalBytes: number
    readonly version: string
  }
  'setup.version_json': { readonly path: string }
  'setup.natives': { readonly extracted: number }
  'setup.marker': { readonly path: string }
  'setup.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'setup.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'setup.failed': { readonly file: string; readonly error: string }
}
