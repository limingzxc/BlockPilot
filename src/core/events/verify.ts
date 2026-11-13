/** verify 域事件载荷。 */
export interface VerifyPayloads {
  'verify.start': { readonly files: number; readonly complete: boolean }
  'verify.done': {
    readonly checked: number
    readonly ok: number
    readonly issues: number
    readonly complete: boolean
  }
}
