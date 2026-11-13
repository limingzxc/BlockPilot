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
import type {
  ArtifactEvent,
  DoneEvent,
  FailedEvent,
  LogLevel,
  ProgressEvent,
  ResultEvent,
} from './base.js'
import type { LogPayloads } from './payloads.js'

export type {
  ArtifactEvent,
  DoneEvent,
  FailedEvent,
  LogLevel,
  ProgressEvent,
  ResultEvent,
} from './base.js'
export type { DeployStep } from './deploy.js'
export type { DownloadStream } from './launch.js'
export type { LogPayloads } from './payloads.js'

/** 全部合法的 log 事件码，由各域载荷的 key 合并而成。 */
export type LogCode = keyof LogPayloads

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
