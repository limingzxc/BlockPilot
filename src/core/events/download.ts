/** 单文件下载域事件载荷（deploy 之外的通用下载）。 */
export interface DownloadPayloads {
  'download.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'download.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'download.failed': { readonly file: string; readonly error: string }
}
