import { join } from 'node:path'

import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { detectJava } from './detect.js'
import type { JavaScanResult } from './types.js'

export interface JavaScanOptions {
  /** 启动器自己管理的 Java 目录，如 <data>/java */
  readonly managedDir?: string
  /** 数据根目录。给了就从 `<root>/java` 推导托管目录，和 `java install` 保持一致 */
  readonly root?: string
}

export function createJavaScan(opts: JavaScanOptions = {}): Operation<JavaScanResult> {
  return defineOperation<JavaScanResult>('java-scan', async function* (signal) {
    const managedDir =
      opts.managedDir ?? (opts.root === undefined ? undefined : join(opts.root, 'java'))
    yield Op.log('info', 'java.scan.start', {
      ...(managedDir === undefined ? {} : { managedDir }),
    })

    const result = await detectJava({
      ...(managedDir === undefined ? {} : { managedDir }),
      signal,
    })

    yield Op.log('info', 'java.scan.done', {
      found: result.installs.length,
      rejected: result.rejected.length,
    })

    yield Op.result(result)
    yield Op.done()
  })
}
