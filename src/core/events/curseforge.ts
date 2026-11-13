/** CurseForge 解析域事件载荷。 */
export interface CurseforgePayloads {
  'cf.resolved': {
    readonly source: string
    readonly files: number
    readonly resolved: number
  }
  'cf.resolve_failed': { readonly message: string }
}
