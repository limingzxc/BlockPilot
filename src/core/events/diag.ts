/** 诊断域事件载荷。 */
export interface DiagPayloads {
  'diag.done': {
    readonly format: 'log' | 'hs-err' | 'crash-report'
    readonly description?: string
    readonly lines: number
    readonly signals: number
    readonly verdict: string
    readonly primary: string | undefined
    readonly frames: number
    readonly culprits: number
  }
}
