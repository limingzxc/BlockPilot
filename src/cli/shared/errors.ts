/**
 * 命令行参数不合法。给稳定 code，别让用户看到 `unexpected error: Error: ...`。
 */
import { BlockPilotError } from '../../core/errors.js'

export class UsageError extends BlockPilotError {
  constructor(code: string, message: string, hint?: string) {
    super(code, message, hint === undefined ? {} : { hint })
    this.name = 'UsageError'
  }
}
