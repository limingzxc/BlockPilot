/** Java 检测与自动安装域事件载荷。 */
export interface JavaPayloads {
  'java.scan.start': { readonly managedDir?: string }
  'java.scan.done': { readonly found: number; readonly rejected: number }
  'java.already_installed': { readonly path: string; readonly major: number }
  'java.lookup': { readonly major: number; readonly os: string }
  'java.download': {
    readonly release: string
    readonly size: number
    readonly checksum: string
  }
  'java.extract': {
    readonly bytes: number
    readonly cached: boolean
    readonly source: string
    readonly credit?: string
  }
  'java.extracted': { readonly files: number; readonly symlinks?: number }
  'java.ready': { readonly path: string; readonly version: string }
}
