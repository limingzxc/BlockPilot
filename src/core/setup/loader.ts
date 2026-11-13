/**
 * 加载器安装的统一 interface。
 *
 * 此前每个 setup 各返回一种结果（`loaderVersion` / `forgeVersion`），于是「装一个
 * Loader」没有接口，只有消费方各写一份分派：`deploy` 的嵌套三元、
 * `update --loader` 的 if 链与 `asLoaderSetup` 适配器、三条 CLI 命令。新增一种
 * 加载器要同时改 8 处，Quilt 还被整段复制成第二份实现（见 ADR-0044）。
 *
 * 这里把「装哪个加载器」收成一张表与一个 Operation：
 * - `needsJava` 是静态能力，消费方据此决定要不要先选 Java（deploy 要在下载原版前就问）
 * - 具体怎么装仍然由四个 adapter 负责，它们的错误码与事件码不变
 * - 结果统一为 {@link LoaderInstallResult}；各加载器特有的计数放 `detail`
 *
 * 分派表是唯一的落点：新增加载器 = 一个 adapter + 表里一行。
 */

import type { OpEvent } from '../events/index.js'
import { Op } from '../events/index.js'
import type { Operation } from '../events/operation.js'
import { defineOperation } from '../events/operation.js'
import type { LoaderKind } from '../instance.js'
import { createFabricSetup } from './fabric.js'
import { createForgeSetup } from './forge.js'
import type { LoaderInstallOptions, LoaderInstallResult } from './loader-types.js'
import { createQuiltSetup } from './quilt.js'

interface LoaderCapability {
  readonly needsJava: boolean
  /** null = 不能自动安装（vanilla） */
  readonly install: ((options: LoaderInstallOptions) => Operation<LoaderInstallResult>) | null
}

const LOADERS: Readonly<Record<LoaderKind, LoaderCapability>> = {
  vanilla: { needsJava: false, install: null },
  fabric: {
    needsJava: false,
    install: (o) =>
      createFabricSetup({
        layout: o.layout,
        gameVersion: o.gameVersion,
        ...(o.loaderVersion === undefined ? {} : { loaderVersion: o.loaderVersion }),
        ...(o.sources === undefined ? {} : { sources: o.sources }),
        ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
        ...(o.mirror === undefined ? {} : { mirror: o.mirror }),
        ...(o.legacy === undefined ? {} : { legacy: o.legacy }),
      }),
  },
  quilt: {
    needsJava: false,
    install: (o) =>
      createQuiltSetup({
        layout: o.layout,
        gameVersion: o.gameVersion,
        ...(o.loaderVersion === undefined ? {} : { loaderVersion: o.loaderVersion }),
        ...(o.sources === undefined ? {} : { sources: o.sources }),
        ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
      }),
  },
  forge: { needsJava: true, install: (o) => installerStep(o, 'forge') },
  neoforge: { needsJava: true, install: (o) => installerStep(o, 'neoforge') },
}

function installerStep(
  o: LoaderInstallOptions,
  kind: 'forge' | 'neoforge',
): Operation<LoaderInstallResult> {
  return createForgeSetup({
    layout: o.layout,
    gameVersion: o.gameVersion,
    kind,
    // NEED_JAVA 已在 createLoaderInstall 里拦过；这里只是给类型一个确定值
    java: o.java ?? '',
    ...(o.loaderVersion === undefined ? {} : { forgeVersion: o.loaderVersion }),
    ...(o.proxy === undefined ? {} : { proxy: o.proxy }),
    ...(o.sources === undefined ? {} : { sources: o.sources }),
  })
}

/** deploy 能自动装的加载器。由分派表派生，不再单独维护一份名单。 */
export const SUPPORTED_LOADERS: ReadonlySet<LoaderKind> = new Set(
  (Object.keys(LOADERS) as LoaderKind[]).filter((kind) => LOADERS[kind].install !== null),
)

/**
 * 装这个加载器要不要先选 Java。
 *
 * 必须在下载原版之前就能回答：`deploy` 不能先白下一轮 90 MB 再报「需要 java」。
 */
export function loaderNeedsJava(kind: LoaderKind): boolean {
  return LOADERS[kind]?.needsJava === true
}

function stepFor(
  opts: LoaderInstallOptions,
): ((options: LoaderInstallOptions) => Operation<LoaderInstallResult>) | null {
  // 注入只覆盖它所对应那一路；另一路仍然走真实 adapter，避免测试绕过分派
  if (opts.deps?.profile !== undefined && (opts.kind === 'fabric' || opts.kind === 'quilt')) {
    return opts.deps.profile
  }
  if (opts.deps?.installer !== undefined && (opts.kind === 'forge' || opts.kind === 'neoforge')) {
    return opts.deps.installer
  }
  return LOADERS[opts.kind]?.install ?? null
}

/**
 * 把一个加载器装进 Instance。所有消费方都从这里进。
 *
 * 事件契约与其它 Operation 一致：log / progress 原样转发，`result` 归一化后
 * 由本 module 产出，`done` 丢弃，`failed` 转发并中止。
 */
export function createLoaderInstall(opts: LoaderInstallOptions): Operation<LoaderInstallResult> {
  return defineOperation<LoaderInstallResult>('loader-install', async function* (signal) {
    const install = stepFor(opts)
    if (install === null) {
      yield Op.failed(
        'UNSUPPORTED_LOADER',
        `不支持自动安装 ${opts.kind}`,
        '目前支持 Fabric、Quilt、Forge 与 NeoForge',
      )
      return
    }
    if (LOADERS[opts.kind]?.needsJava === true && opts.java === undefined) {
      yield Op.failed(
        'NEED_JAVA',
        `${opts.kind} 需要 java 来跑 installer`,
        '传 --java 或先跑 java 检测',
      )
      return
    }

    let result: LoaderInstallResult | undefined
    for await (const ev of install(opts).run(signal)) {
      if (ev.type === 'result') {
        result = ev.value
        continue
      }
      if (ev.type === 'done') continue
      if (ev.type === 'failed') {
        yield ev
        return
      }
      yield ev as OpEvent<never>
    }

    if (result === undefined) {
      yield Op.failed('LOADER_FAILED', '加载器没装成')
      return
    }

    yield Op.result(result)
    yield Op.done()
  })
}
