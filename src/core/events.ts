/**
 * OpEvent —— Operation 的唯一输出形式。
 *
 * 规矩：core 内不允许出现 console.log / process.stdout。
 * 所有状态变化必须先成为事件，由 Consumer（cli / mcp / 未来的 gui）决定怎么渲染。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type OpEvent<T = unknown> =
  | {
      readonly type: 'progress'
      readonly taskId: string
      readonly done: number
      readonly total: number
      readonly label: string
    }
  | {
      readonly type: 'log'
      readonly level: LogLevel
      /** 稳定的机器码，不是给人读的句子 */
      readonly code: string
      readonly data?: unknown
    }
  | {
      readonly type: 'artifact'
      readonly path: string
    }
  /** 操作产出的最终结果。一个 Operation 最多 yield 一次。 */
  | {
      readonly type: 'result'
      readonly value: T
    }
  | {
      readonly type: 'failed'
      readonly code: string
      readonly message: string
      readonly hint?: string
    }
  | { readonly type: 'done' }

/**
 * 便利构造器。
 *
 * 非 result 的构造器一律返回 `OpEvent<never>`——这样它们可以安全地混进
 * 任何 `OpEvent<T>` 的事件流，而 `result` 保持精确的 T。
 */
export const Op = {
  progress: (taskId: string, done: number, total: number, label: string): OpEvent<never> => ({
    type: 'progress',
    taskId,
    done,
    total,
    label,
  }),
  log: (level: LogLevel, code: string, data?: unknown): OpEvent<never> => ({
    type: 'log',
    level,
    code,
    ...(data === undefined ? {} : { data }),
  }),
  result: <T>(value: T): OpEvent<T> => ({ type: 'result', value }),
  failed: (code: string, message: string, hint?: string): OpEvent<never> => ({
    type: 'failed',
    code,
    message,
    ...(hint === undefined ? {} : { hint }),
  }),
  done: (): OpEvent<never> => ({ type: 'done' }),
} as const
