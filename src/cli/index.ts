#!/usr/bin/env node
/**
 * CLI 入口：只判断「当前模块是不是入口」，然后交给 main.ts。
 *
 * `hints.test.ts` / `readme.test.ts` 需要命令集合时从 registry.ts 取，
 * 不再 import 这个文件——入口的副作用只留在一个地方。
 */
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { main, reportFatal } from './main.js'
import { emitExit, isEventStream } from './output/stream.js'

/**
 * 判断当前模块是不是入口。
 *
 * 不能用 `import.meta.url === pathToFileURL(process.argv[1]).href`：npm link /
 * 全局安装时 bin 是符号链接，argv[1] 是链接路径，而 ESM 的 import.meta.url
 * 已经是 realpath，比较永远不相等，CLI 会静默退出 0。两边都取 realpath。
 */
export function isEntryPoint(entry: string | undefined): boolean {
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint(process.argv[1])) {
  main().then((code) => {
    // 有些命令在进入 Operation 前就返回（缺位置参数、未知 flag）：
    // 兜底保证事件流最后一行永远是 exit
    if (isEventStream()) emitExit(code)
    // 不用 process.exit：管道里的 --json 大输出可能还没 flush 完就被截断
    process.exitCode = code
  }, reportFatal)
}
