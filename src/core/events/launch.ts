/** 启动域事件载荷（含游戏输出流）。 */
import type { LaunchEnv } from '../launch-env.js'

export type DownloadStream = 'stdout' | 'stderr'

export interface LaunchPayloads {
  'launch.env': LaunchEnv
  'launch.version.fetch': { readonly versionId: string }
  'launch.version.loaded': {
    readonly id: string
    readonly rootId: string
    readonly type: string
    readonly libraries: number
    readonly hasModernArgs: boolean
    readonly javaMajorVersion?: number
  }
  'launch.plan.ready': {
    readonly mainClass: string
    readonly classpathEntries: number
    readonly missing: number
  }
  'launch.spawn': {
    readonly java: string
    readonly mainClass: string
    readonly cwd: string
    readonly args: number
  }
  'launch.logfile': { readonly path: string }
  'launch.autostop': { readonly seconds: number }
  'launch.aborted': undefined
  'launch.spawn_failed': { readonly message: string }
  'launch.died_before_stop': { readonly idleMs: number; readonly durationMs: number }
  'launch.exited_abnormally': {
    readonly code: number | null
    readonly signal: NodeJS.Signals | null
    readonly durationMs: number
  }
  'launch.exited': { readonly code: number | null; readonly durationMs: number }
  'game.output': { readonly stream: DownloadStream; readonly line: string }
}
