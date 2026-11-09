/**
 * 项目内的错误基类。
 *
 * 之前每个模块自带一个错误类型（`LayoutError` / `NetworkError` /
 * `VersionNotFoundError` / `CurseforgeError` / `AuthError` / `UsageError`），
 * 顶层的 `reportFatal` 只能靠一串 `instanceof` 阶梯认识它们；新加一种错误就
 * 悄悄落进 `unexpected error`。`collect()` 又手动给 `Error` 挂 `code`，类型上
 * 完全看不见。
 *
 * 现在统一成 `BlockPilotError { code, message, hint }`：
 * - `code` 是稳定机器码（与 OpEvent.failed.code 同一套）
 * - `hint` 是「接下来能做什么」，渲染层决定要不要显示
 *
 * 不追求把所有 throw 都改成它——只在**跨模块边界**使用。内部断言仍然可以是
 * 普通 Error，`asBlockPilotError()` 会在边界处兜底。
 */

export interface BlockPilotErrorOptions {
  readonly hint?: string
  readonly cause?: unknown
}

export class BlockPilotError extends Error {
  readonly code: string
  readonly hint: string | undefined

  constructor(code: string, message: string, opts: BlockPilotErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'BlockPilotError'
    this.code = code
    this.hint = opts.hint
  }
}

export function isBlockPilotError(err: unknown): err is BlockPilotError {
  return err instanceof BlockPilotError
}

/**
 * 任意 throw 值 → 可读消息。
 *
 * `err instanceof Error ? err.message : String(err)` 在仓库里写了十几遍，
 * 每次都要重新判断一次 `unknown`。集中一处，顺便把 `undefined` 变成 `'undefined'`
 * 而不是空串。
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** 边界兜底：不是 BlockPilotError 的 throw 也包成带稳定 code 的形状。 */
export function asBlockPilotError(err: unknown, code = 'INTERNAL'): BlockPilotError {
  if (err instanceof BlockPilotError) return err
  return new BlockPilotError(code, errMessage(err), { cause: err })
}
