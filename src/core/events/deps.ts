/** 依赖闭包域事件载荷。 */
export interface DepsPayloads {
  'deps.closure.start': { readonly roots: number }
  'deps.closure.done': {
    readonly visited: number
    readonly missing: number
    readonly cycles: number
    readonly truncated: boolean
  }
  'deps.closure.skipped': { readonly reason: string }
}
