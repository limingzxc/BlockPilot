/** 部署域事件载荷。 */
import type { LoaderRef } from '../instance.js'

export type DeployStep = 'vanilla' | 'loader' | 'files' | 'overrides' | 'check'

export interface DeployPayloads {
  'deploy.pack': {
    readonly name: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly files: number
  }
  'deploy.step': { readonly step: DeployStep }
  'deploy.cf_source': { readonly source: string }
  'deploy.cf_no_key': { readonly files: number }
  'deploy.check': {
    readonly verdict: 'ok' | 'warn' | 'blocked' | 'unknown'
    readonly blockers: number
    readonly findings: number
    readonly unresolved: number
  }
  'deploy.pack_changed': {
    readonly from: string
    readonly to: string
    readonly previousFiles: number
  }
  'deploy.overrides_skipped': { readonly count: number }
  'deploy.overrides_failed': { readonly message: string }
  'deploy.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'deploy.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'deploy.failed': { readonly file: string; readonly error: string }
  'deploy.lock': { readonly path: string; readonly files: number }
  'deploy.lock_failed': { readonly message: string }
}
