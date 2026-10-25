/**
 * 极简异步队列。用途：让并发 worker 把事件推给外层的 async generator。
 *
 * generator 里不能从 Promise 回调中 yield，所以 worker 推、generator 拉。
 */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: Array<() => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.waiters.shift()?.()
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) this.waiters.shift()?.()
  }

  async *drain(): AsyncGenerator<T, void, unknown> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T
        continue
      }
      if (this.closed) return
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }
}

/** 固定并发的任务池。抛错会中止整池。 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index] as T, index)
    }
  })
  await Promise.all(runners)
}
