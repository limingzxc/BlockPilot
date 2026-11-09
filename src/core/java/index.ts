import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { detectJava } from './detect.js'
import type { JavaScanResult } from './types.js'

export interface JavaScanOptions {
  /** 启动器自己管理的 Java 目录，如 <data>/java */
  readonly managedDir?: string
}

export function createJavaScan(opts: JavaScanOptions = {}): Operation<JavaScanResult> {
  return defineOperation<JavaScanResult>('java-scan', async function* (signal) {
    yield Op.log('info', 'java.scan.start', {
      ...(opts.managedDir === undefined ? {} : { managedDir: opts.managedDir }),
    })

    const result = await detectJava({
      ...(opts.managedDir === undefined ? {} : { managedDir: opts.managedDir }),
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
