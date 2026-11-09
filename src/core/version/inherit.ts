import type { ArgEntry, Library, VersionJson } from './types.js'

/**
 * library 的身份是 `group:artifact:classifier`，**再加上 OS 变体**——**版本和 classifier 的区别要分清**：
 *
 * - 版本不进 key：这样加载器的 asm:9.10.1 才能覆盖原版的 asm:9.7
 * - classifier **必须**进 key：`org.lwjgl:lwjgl` 和 `org.lwjgl:lwjgl:natives-windows`
 *   是同一个 artifact 的两个不同产物。只按 group:artifact 去重会把 88 个库压成 53 个，
 *   lwjgl 主 jar 被 natives 变体覆盖，启动时报
 *   `NoClassDefFoundError: org/lwjgl/system/MemoryUtil`。
 * - OS 变体也必须进 key：1.12.2 的版本 JSON 里同一个 `org.lwjgl.lwjgl:lwjgl` 有两份，
 *   2.9.4（allow 全部、disallow osx）与 2.9.2（只 allow osx）。压成一份的话，
 *   留在 Windows 上的是「只允许 osx」的 2.9.2，被规则过滤掉之后一个 lwjgl 都没有，
 *   启动直接 `NoClassDefFoundError: org/lwjgl/opengl/Display`。
 */
export function libraryKey(lib: Library): string {
  const parts = lib.name.split(':')
  const group = parts[0] ?? ''
  const artifact = parts[1] ?? ''
  const classifier = parts[3] ?? ''
  const variant = (lib.rules ?? [])
    .filter((r) => r.os !== undefined)
    .map((r) => `${r.action}:${r.os?.name ?? '*'}:${r.os?.arch ?? '*'}`)
    .join(',')
  return `${group}:${artifact}${classifier === '' ? '' : `:${classifier}`}${
    variant === '' ? '' : `|${variant}`
  }`
}

function mergeLibraries(parent: readonly Library[], child: readonly Library[]): readonly Library[] {
  const map = new Map<string, Library>()
  for (const lib of parent) map.set(libraryKey(lib), lib)
  // 子覆盖父：后写入的赢
  for (const lib of child) map.set(libraryKey(lib), lib)
  return [...map.values()]
}

function mergeArguments(
  parent: VersionJson['arguments'],
  child: VersionJson['arguments'],
): VersionJson['arguments'] {
  if (parent === undefined && child === undefined) return undefined
  const game: ArgEntry[] = [...(parent?.game ?? []), ...(child?.game ?? [])]
  const jvm: ArgEntry[] = [...(parent?.jvm ?? []), ...(child?.jvm ?? [])]
  return { game, jvm }
}

/** 只覆盖 child 里明确给了值的字段。子 JSON 通常没有 downloads/assetIndex，不能让它们变成 undefined。 */
function overlay(parent: VersionJson, child: Partial<VersionJson>): VersionJson {
  const out = { ...parent } as Record<string, unknown>
  for (const [key, value] of Object.entries(child)) {
    if (value !== undefined) out[key] = value
  }
  return out as unknown as VersionJson
}

/**
 * 合并父版本与子版本（加载器 profile）。
 *
 * 规则（与 HMCL / Prism 的实现一致）：
 * - `id` / `mainClass`：子覆盖父
 * - `libraries`：按 group:artifact 合并，子覆盖父
 * - `arguments`：父在前、子在后**拼接**，不是替换
 * - 其余字段：子有值则覆盖，没值则保留父的
 *
 * `arguments` 必须拼接而不是替换：子 JSON 只写自己新增的 JVM 参数
 * （Fabric 那条 `-DFabricMcEmu=...`），原版的 `-cp`、`-Djava.library.path`
 * 全在父 JSON 里。替换掉就启动不了。
 */
export function mergeVersionJson(parent: VersionJson, child: VersionJson): VersionJson {
  const args = mergeArguments(parent.arguments, child.arguments)
  return overlay(parent, {
    ...child,
    libraries: mergeLibraries(parent.libraries, child.libraries ?? []),
    ...(args === undefined ? {} : { arguments: args }),
  })
}
