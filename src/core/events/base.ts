/**
 * 事件外壳：与具体业务域无关的四种形态。
 *
 * log 事件的 code/data 由 `payloads.ts` 汇总的各域形状决定；
 * `OpEvent`/`Op` 在 index.ts 组合，避免 base 与 payloads 互相依赖。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface ProgressEvent {
  readonly type: 'progress'
  readonly taskId: string
  readonly done: number
  readonly total: number
  readonly label: string
}

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
