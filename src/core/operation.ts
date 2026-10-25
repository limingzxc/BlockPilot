import type { OpEvent } from './events.js'

/**
 * Operation —— core 暴露的最小可执行单元。
 *
 * 三条硬要求（见 ADR-0001）：
 *   可取消：必须响应 signal，中断时停止一切副作用
 *   可重入：失败后重跑不产生半成品
 *   可观察：每个阶段都有事件，不能闷头干完再说话
 */
export interface Operation<T = void> {
  readonly id: string
  run(signal: AbortSignal): AsyncIterable<OpEvent<T>>
}

/** 把一个 async generator 包成 Operation，省掉样板代码。 */
export function defineOperation<T>(
  id: string,
  body: (signal: AbortSignal) => AsyncGenerator<OpEvent<T>, void, unknown>,
): Operation<T> {
  return {
    id,
    run: (signal) => body(signal),
  }
}

/** 供 Consumer 使用：把事件流跑完，取出 result 或抛错。 */
export async function collect<T>(op: Operation<T>, signal?: AbortSignal): Promise<T> {
  const controller = signal ?? new AbortController().signal
  for await (const ev of op.run(controller)) {
    if (ev.type === 'result') return ev.value as T
    if (ev.type === 'failed') {
      const err = new Error(`${ev.code}: ${ev.message}`)
      ;(err as Error & { code?: string }).code = ev.code
      throw err
    }
  }
  throw new Error(`operation ${op.id} finished without a result`)
}
