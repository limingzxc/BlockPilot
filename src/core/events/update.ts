/** 更新检查域事件载荷。 */
export interface UpdatePayloads {
  'update.start': { readonly files: number }
  'update.done': {
    readonly checked: number
    readonly updates: number
    readonly failed: number
  }
  'update.applied': { readonly path: string; readonly from: string; readonly to: string }
  'update.apply_failed': { readonly path: string; readonly error: string }
  'loader.updated': { readonly from: string; readonly to: string }
}
