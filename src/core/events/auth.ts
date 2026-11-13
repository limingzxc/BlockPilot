/** 认证域事件载荷。新增认证事件只改这个文件。 */
export interface AuthPayloads {
  'auth.step': { readonly step: string }
  'auth.device_code': {
    readonly userCode: string
    readonly verificationUri: string
    readonly expiresAt: number
    readonly expiresInSec: number
    readonly intervalMs: number
  }
}
