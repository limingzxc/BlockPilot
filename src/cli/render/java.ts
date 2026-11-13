/**
 * Java 选择失败的渲染。
 *
 * `javaInstallHint` 是 core 里的纯文案构造器，这里只负责颜色与 stderr。
 */

import { javaInstallHint } from '../../core/hints.js'
import { C } from '../output/ansi.js'

export function renderJavaFailure(failure: { message: string; needMajor?: number }): void {
  process.stderr.write(`${C.red}${failure.message}${C.reset}\n`)
  // 只说「没有」而不说怎么办，用户下一步只能去搜。给一条能直接敲的命令
  if (failure.needMajor !== undefined) {
    process.stderr.write(`${C.dim}可以装一个：${javaInstallHint(failure.needMajor)}${C.reset}\n`)
  }
}
