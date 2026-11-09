/**
 * 把实例的加载器升到最新兼容版。
 *
 * 只改加载器：版本 JSON、loader 库、`mmc-pack.json` 的 loader 组件由各 setup
 * 负责；模组文件不动。升级后 lock 的 `target.loader.version` 也要跟着改，
 * 否则下一次 `update` 仍按旧 loader 过滤。
 *
 * 具体用哪个 setup 由调用方注入（Fabric / Quilt / Forge 的流程不同），
 * 这个 module 只负责「跑 setup → 成功才写 lock」。
 */

import type { OpEvent } from '../events.js'
import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import type { LockFile } from './lock.js'
import { readLock, writeLock } from './lock.js'

export interface LoaderSetupOutcome {
  readonly versionId: string
  readonly loaderVersion: string
  readonly versionJsonPath?: string
}

export interface LoaderUpdateOptions {
  readonly gameDir: string
  readonly setup: Operation<LoaderSetupOutcome>
}

export interface LoaderUpdateResult {
  readonly from: string
  readonly to: string
  readonly versionId: string
  readonly versionJsonPath?: string
}

export function updateLoader(opts: LoaderUpdateOptions): Operation<LoaderUpdateResult> {
  return defineOperation<LoaderUpdateResult>('loader-update', async function* (signal) {
    let lock: LockFile | null
    try {
      lock = readLock(opts.gameDir)
    } catch (err) {
      if (err instanceof Error && 'code' in err) {
        yield Op.failed(String((err as { code: unknown }).code), err.message)
        return
      }
      throw err
    }
    if (lock === null) {
      yield Op.failed(
        'LOCK_NOT_FOUND',
        '这个实例没有 lock.json，无法知道当前加载器版本',
        '用 blockpilot deploy <整合包> 装一次会生成',
      )
      return
    }

    const from = lock.target.loader.version
    let outcome: LoaderSetupOutcome | undefined

    for await (const ev of opts.setup.run(signal)) {
      if (ev.type === 'result') {
        outcome = ev.value
        continue
      }
      if (ev.type === 'done') continue
      yield ev as OpEvent<LoaderUpdateResult>
    }

    if (outcome === undefined) {
      yield Op.failed('LOADER_UPDATE_NO_RESULT', '加载器安装没有产出结果')
      return
    }

    // setup 成功才写 lock：失败时旧版本仍可启动
    writeLock(opts.gameDir, {
      ...lock,
      target: {
        ...lock.target,
        loader: { ...lock.target.loader, version: outcome.loaderVersion },
      },
      updatedAt: new Date().toISOString(),
    })

    yield Op.log('info', 'loader.updated', { from, to: outcome.loaderVersion })
    yield Op.result({
      from,
      to: outcome.loaderVersion,
      versionId: outcome.versionId,
      ...(outcome.versionJsonPath === undefined
        ? {}
        : { versionJsonPath: outcome.versionJsonPath }),
    })
    yield Op.done()
  })
}
