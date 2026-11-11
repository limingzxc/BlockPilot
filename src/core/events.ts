/**
 * OpEvent —— Operation 的唯一输出形式。
 *
 * 规矩：core 内不允许出现 console.log / process.stdout。
 * 所有状态变化必须先成为事件，由 Consumer（cli / mcp / 未来的 gui）决定怎么渲染。
 *
 * `log` 事件的 code 与 data 是**成对**的：`LogCode` 是全部合法机器码，
 * `LogPayloads` 给出每个码的载荷形状。消费者按 `ev.code` 收窄后，
 * `ev.data` 就是具体类型，不用再 `as { file?: string }`。
 */
import type { LoaderRef } from './instance.js'
import type { LaunchEnv } from './launch/env.js'

export type LogLevel = 'info' | 'warn' | 'error'

/** 全部合法的 log 事件码。新增事件必须先在这里登记。 */
export type LogCode =
  // 认证
  | 'auth.step'
  | 'auth.device_code'
  // 资源
  | 'assets.tasks'
  | 'assets.ok'
  | 'assets.cached'
  | 'assets.failed'
  // CurseForge
  | 'cf.resolved'
  | 'cf.resolve_failed'
  // 部署
  | 'deploy.pack'
  | 'deploy.pack_changed'
  | 'deploy.step'
  | 'deploy.cf_source'
  | 'deploy.cf_no_key'
  | 'deploy.check'
  | 'deploy.overrides_skipped'
  | 'deploy.overrides_failed'
  | 'deploy.ok'
  | 'deploy.cached'
  | 'deploy.failed'
  | 'deploy.lock'
  | 'deploy.lock_failed'
  // 依赖闭包
  | 'deps.closure.start'
  | 'deps.closure.done'
  | 'deps.closure.skipped'
  // 诊断
  | 'diag.done'
  // 下载
  | 'download.ok'
  | 'download.cached'
  | 'download.failed'
  // Fabric
  | 'fabric.legacy'
  | 'fabric.loader'
  | 'fabric.profile'
  | 'fabric.no_hash'
  | 'fabric.version_json'
  | 'fabric.marker'
  | 'fabric.natives'
  | 'fabric.ok'
  | 'fabric.cached'
  | 'fabric.failed'
  // Quilt
  | 'quilt.loader'
  | 'quilt.profile'
  | 'quilt.no_hash'
  | 'quilt.version_json'
  | 'quilt.marker'
  | 'quilt.natives'
  | 'quilt.ok'
  | 'quilt.cached'
  | 'quilt.failed'
  // Forge / NeoForge
  | 'forge.already_installed'
  | 'forge.installer_url'
  | 'forge.installer_downloaded'
  | 'forge.installer_mirrored'
  | 'forge.installer_mirror_failed'
  | 'forge.installer_run'
  | 'forge.installer_retry'
  | 'forge.installer_failed'
  | 'forge.installed'
  // 安装
  | 'install.nothing_to_do'
  | 'install.partial'
  // 实例
  | 'instance.scanned'
  | 'modpack.reading'
  | 'modpack.parsed'
  | 'modpack.curseforge'
  // Java
  | 'java.scan.start'
  | 'java.scan.done'
  | 'java.already_installed'
  | 'java.lookup'
  | 'java.download'
  | 'java.extract'
  | 'java.extracted'
  | 'java.ready'
  // 启动
  | 'launch.env'
  | 'launch.version.fetch'
  | 'launch.version.loaded'
  | 'launch.plan.ready'
  | 'launch.spawn'
  | 'launch.logfile'
  | 'launch.autostop'
  | 'launch.aborted'
  | 'launch.spawn_failed'
  | 'launch.died_before_stop'
  | 'launch.exited_abnormally'
  | 'launch.exited'
  | 'game.output'
  // 原版
  | 'setup.tasks'
  | 'setup.version_json'
  | 'setup.natives'
  | 'setup.marker'
  | 'setup.ok'
  | 'setup.cached'
  | 'setup.failed'
  // 校验
  | 'verify.start'
  | 'verify.done'
  // 更新检查
  | 'update.start'
  | 'update.done'
  | 'update.applied'
  | 'update.apply_failed'
  | 'loader.updated'

export type DeployStep = 'vanilla' | 'loader' | 'files' | 'overrides' | 'check'
export type DownloadStream = 'stdout' | 'stderr'

/** code → data 的映射。没有载荷的码写 `undefined`。 */
export interface LogPayloads {
  'auth.step': { readonly step: string }
  'auth.device_code': {
    readonly userCode: string
    readonly verificationUri: string
    readonly expiresAt: number
    readonly expiresInSec: number
    readonly intervalMs: number
  }

  'assets.tasks': {
    readonly index: string
    readonly keys: number
    readonly unique: number
    readonly totalBytes: number
  }
  'assets.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'assets.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'assets.failed': { readonly file: string; readonly error: string }

  'cf.resolved': {
    readonly source: string
    readonly files: number
    readonly resolved: number
  }
  'cf.resolve_failed': { readonly message: string }

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

  'deps.closure.start': { readonly roots: number }
  'deps.closure.done': {
    readonly visited: number
    readonly missing: number
    readonly cycles: number
    readonly truncated: boolean
  }
  'deps.closure.skipped': { readonly reason: string }

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

  'download.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'download.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'download.failed': { readonly file: string; readonly error: string }

  'fabric.legacy': { readonly gameVersion: string }
  'fabric.loader': {
    readonly gameVersion: string
    readonly loaderVersion: string
    readonly flavor: 'official' | 'legacy'
  }
  'fabric.profile': { readonly id: string; readonly libraries: number }
  'fabric.no_hash': { readonly count: number; readonly libs: readonly string[] }
  'fabric.version_json': { readonly path: string }
  'fabric.marker': { readonly path: string }
  'fabric.natives': { readonly extracted: number }
  'fabric.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'fabric.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'fabric.failed': { readonly file: string; readonly error: string }

  'quilt.loader': { readonly gameVersion: string; readonly loaderVersion: string }
  'quilt.profile': { readonly id: string; readonly libraries: number }
  'quilt.no_hash': { readonly count: number; readonly libs: readonly string[] }
  'quilt.version_json': { readonly path: string }
  'quilt.marker': { readonly path: string }
  'quilt.natives': { readonly extracted: number }
  'quilt.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'quilt.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'quilt.failed': { readonly file: string; readonly error: string }

  'forge.already_installed': { readonly versionId: string }
  'forge.installer_url': { readonly url: string }
  'forge.installer_downloaded': { readonly bytes: number }
  'forge.installer_mirrored': { readonly from: string; readonly to: string }
  'forge.installer_mirror_failed': { readonly error: string }
  'forge.installer_run': { readonly note: string }
  'forge.installer_retry': { readonly code: number | null; readonly tail: readonly string[] }
  'forge.installer_failed': { readonly code: number | null; readonly tail: readonly string[] }
  'forge.installed': { readonly versionId: string }

  'install.nothing_to_do': undefined
  'install.partial': { readonly ok: number; readonly failed: number }

  'instance.scanned': {
    readonly dir: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly skipped: number
  }
  'modpack.reading': { readonly path: string }
  'modpack.parsed': {
    readonly name: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly overridesMods: number
  }
  'modpack.curseforge': {
    readonly name: string
    readonly gameVersion: string
    readonly loader: LoaderRef
    readonly mods: number
    readonly overridesMods: number
  }

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

  'setup.tasks': {
    readonly tasks: number
    readonly totalBytes: number
    readonly version: string
  }
  'setup.version_json': { readonly path: string }
  'setup.natives': { readonly extracted: number }
  'setup.marker': { readonly path: string }
  'setup.ok': { readonly file: string; readonly bytes: number; readonly source: string }
  'setup.cached': { readonly file: string; readonly bytes: number; readonly source: string }
  'setup.failed': { readonly file: string; readonly error: string }

  'verify.start': { readonly files: number; readonly complete: boolean }
  'verify.done': {
    readonly checked: number
    readonly ok: number
    readonly issues: number
    readonly complete: boolean
  }

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

export interface ProgressEvent {
  readonly type: 'progress'
  readonly taskId: string
  readonly done: number
  readonly total: number
  readonly label: string
}

/** 按 code 判别的 log 事件：`ev.code === 'deploy.step'` 之后 `ev.data.step` 是具体类型。 */
export type LogEvent = {
  [K in LogCode]: {
    readonly type: 'log'
    readonly level: LogLevel
    /** 稳定的机器码，不是给人读的句子 */
    readonly code: K
  } & (LogPayloads[K] extends undefined
    ? { readonly data?: undefined }
    : { readonly data: LogPayloads[K] })
}[LogCode]

export interface ArtifactEvent {
  readonly type: 'artifact'
  readonly path: string
}

/** 操作产出的最终结果。一个 Operation 最多 yield 一次。 */
export interface ResultEvent<T> {
  readonly type: 'result'
  readonly value: T
}

export interface FailedEvent {
  readonly type: 'failed'
  readonly code: string
  readonly message: string
  readonly hint?: string
}

export interface DoneEvent {
  readonly type: 'done'
}

export type OpEvent<T = unknown> =
  | ProgressEvent
  | LogEvent
  | ArtifactEvent
  | ResultEvent<T>
  | FailedEvent
  | DoneEvent

type LogArgs<K extends LogCode> = LogPayloads[K] extends undefined ? [] : [data: LogPayloads[K]]

/**
 * 便利构造器。
 *
 * 非 result 的构造器一律返回 `OpEvent<never>`——这样它们可以安全地混进
 * 任何 `OpEvent<T>` 的事件流，而 `result` 保持精确的 T。
 */
export const Op = {
  progress: (taskId: string, done: number, total: number, label: string): ProgressEvent => ({
    type: 'progress',
    taskId,
    done,
    total,
    label,
  }),
  log: <K extends LogCode>(level: LogLevel, code: K, ...args: LogArgs<K>): LogEvent => {
    const data = args[0]
    return {
      type: 'log',
      level,
      code,
      ...(data === undefined ? {} : { data }),
    } as LogEvent
  },
  result: <T>(value: T): ResultEvent<T> => ({ type: 'result', value }),
  failed: (code: string, message: string, hint?: string): FailedEvent => ({
    type: 'failed',
    code,
    message,
    ...(hint === undefined ? {} : { hint }),
  }),
  done: (): DoneEvent => ({ type: 'done' }),
} as const
