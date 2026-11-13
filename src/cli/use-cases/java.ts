/**
 * 「挑 Java」用例：组合 core 的选择逻辑，返回结构化结果。
 *
 * 这里不写输出——成功给路径，失败给 message / needMajor，由命令层决定怎么渲染。
 * 三个子命令共用同一处，避免各自实现后策略漂移（ADR-0023）。
 */
import { selectJava } from '../../core/java/select.js'
import type { Layout } from '../../core/layout.js'

export interface JavaUnavailable {
  readonly ok: false
  readonly message: string
  /** 缺哪个大版本。拿不到时不给安装建议 */
  readonly needMajor?: number
}

export type JavaSelection = { readonly ok: true; readonly path: string } | JavaUnavailable

export async function pickJava(
  versionId: string | undefined,
  layout: Layout,
  signal: AbortSignal,
  explicit: string | undefined,
): Promise<JavaSelection> {
  const outcome = await selectJava({
    ...(versionId === undefined ? {} : { versionId }),
    layoutRoot: layout.root,
    // 传整个 layout：只有它能读到 versions/<id>/<id>.json 里的 javaVersion
    layout,
    signal,
    ...(explicit === undefined ? {} : { explicit }),
  })
  if (outcome.ok) return { ok: true, path: outcome.path }
  return {
    ok: false,
    message: outcome.message,
    ...(outcome.needMajor === undefined ? {} : { needMajor: outcome.needMajor }),
  }
}
