/**
 * 加载器安装用例：把命令上下文里的 layout / sources / 镜像策略补进 core 的安装接口。
 *
 * fabric / forge / quilt / update 不再各自拼 `createLoaderInstall` 的参数；
 * 新增一种加载器时，命令只传 kind 与差异字段。
 */

import type { Operation } from '../../core/events/operation.js'
import type { LoaderKind } from '../../core/instance.js'
import { createLoaderInstall } from '../../core/setup/loader.js'
import type { LoaderInstallResult } from '../../core/setup/loader-types.js'
import type { CommandContext } from '../command/context.js'

export interface LoaderInstallRequest {
  readonly kind: LoaderKind
  readonly gameVersion: string
  readonly loaderVersion?: string
  readonly legacy?: boolean
  readonly java?: string
  readonly proxy?: string
}

export function installLoader(
  ctx: CommandContext,
  req: LoaderInstallRequest,
): Operation<LoaderInstallResult> {
  return createLoaderInstall({
    kind: req.kind,
    layout: ctx.layout,
    gameVersion: req.gameVersion,
    ...(req.loaderVersion === undefined ? {} : { loaderVersion: req.loaderVersion }),
    ...(req.legacy === undefined ? {} : { legacy: req.legacy }),
    ...(req.java === undefined ? {} : { java: req.java }),
    ...(req.proxy === undefined ? {} : { proxy: req.proxy }),
    sources: ctx.sources,
    mirror: ctx.china,
  })
}

export { loaderNeedsJava } from '../../core/setup/loader.js'
