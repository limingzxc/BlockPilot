/**
 * 子 Operation 的事件转发。
 *
 * 契约——调用方对所有子步骤的约定，只写这一次：
 * - log / progress / artifact 原样转发
 * - result 交给 onResult 消费，不转发：result 一个 Operation 只 yield 一次，
 *   外层自己还要产出自己的 result，混在一起消费者分不清
 * - done 不转发：子步骤结束不代表整体结束
 * - failed 原样转发并立即中止整体
 */
import type { OpEvent } from '../events/index.js'
import type { Operation } from '../events/operation.js'

export async function* forwardStep<T>(
  step: Operation<T>,
  signal: AbortSignal,
  onResult: (value: T) => void,
): AsyncGenerator<OpEvent<never>, boolean> {
  for await (const ev of step.run(signal)) {
    if (ev.type === 'result') {
      onResult(ev.value)
      continue
    }
    if (ev.type === 'done') continue
    if (ev.type === 'failed') {
      yield ev
      return true
    }
    yield ev as OpEvent<never>
  }
  return false
}
