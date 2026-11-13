import { strFromU8, unzipSync } from 'fflate'

import type { LoaderKind } from '../instance.js'
import { CANDIDATES, FABRIC, FORGE, isNestedJar, MCMOD, NEOFORGE, QUILT } from './formats.js'
import { parseCandidate } from './parsers.js'
import type { ModLoaderKind, ModMetadata } from './types.js'

/**
 * 候选元数据的读取顺序。
 *
 * `CANDIDATES` 是「不知道实例是什么加载器」时的缺省值。知道加载器时要按它挑：
 * `Towns-and-Towers-1.12-Fabric+Forge.jar` 同时有 `fabric.mod.json` 和
 * `META-INF/mods.toml`，在 Forge 实例里读 fabric 那一侧，会凭空多出
 * `fabric-api` 依赖（issue #17）。
 */
function candidateOrder(opts: ReadModMetadataOptions): readonly string[] {
  // 1.12.2 及更早：mcmod.info 才是这一代的元数据，mods.toml 常是构建模板残留
  if (opts.legacy === true) return [FABRIC, QUILT, MCMOD, NEOFORGE, FORGE]
  switch (opts.loader) {
    case 'forge':
      return [FORGE, NEOFORGE, FABRIC, QUILT, MCMOD]
    case 'neoforge':
      return [NEOFORGE, FORGE, FABRIC, QUILT, MCMOD]
    case 'quilt':
      return [QUILT, FABRIC, NEOFORGE, FORGE, MCMOD]
    default:
      return CANDIDATES
  }
}

/** jar-in-jar 里读出来的一个子模组。`loader` 供「只有 JiJ」的 jar 定身份用。 */
interface NestedJarMod {
  readonly modId: string
  readonly version: string
  readonly loader: ModLoaderKind
}

/** 读 `META-INF/jars/*.jar` 里的嵌套模组。Fabric API 的 57 个子模块都在这里。 */
function readNestedJars(
  entries: Record<string, Uint8Array>,
  order: readonly string[],
): NestedJarMod[] {
  const out: NestedJarMod[] = []
  for (const [name, data] of Object.entries(entries)) {
    if (!isNestedJar(name)) continue
    try {
      // 嵌套 jar 可能是 Fabric 风格（fabric.mod.json）或 Forge 风格（mods.toml）
      const inner = unzipSync(data, {
        filter: (f) => order.includes(f.name),
      })
      for (const candidate of order) {
        const buf = inner[candidate]
        if (buf === undefined) continue
        const meta = parseCandidate(candidate, strFromU8(buf))
        if (meta === null) continue
        out.push({ modId: meta.modId, version: meta.version, loader: meta.loader })
        break
      }
    } catch {
      // 嵌套 jar 坏了不影响主 jar 的元数据
    }
  }
  return out
}

/**
 * 从 jar 的字节里读出模组元数据。
 *
 * 只解压四个候选条目和 `META-INF/jars/*.jar`——真实的 mod jar 可能有几千个 class，
 * 全解会吃掉时间和内存。读不出来就返回 null：损坏的 jar、资源包、
 * 甚至伪装成 mod 的文件都会走这条路。
 */
export interface ReadModMetadataOptions {
  /**
   * 实例是否 ≤1.12.2。
   *
   * 老版本只认 mcmod.info，新版本只认 mods.toml。两者同时存在时（作者复用了构建模板），
   * 按实例版本挑对的那一份：RLCraft 的 SpartanShields 里 mods.toml 写的是
   * `minecraft [1.13.2]`（1.13 模板残留），mcmod.info 写的才是 `1.12.2`。
   */
  readonly legacy?: boolean
  /**
   * 实例的加载器。多加载器 jar（同时带 fabric.mod.json 与 mods.toml）要按它挑元数据，
   * 否则在 Forge 实例里会读出 Fabric 那一侧的依赖，凭空报缺 fabric-api（issue #17）。
   */
  readonly loader?: LoaderKind
}

/**
 * 这个文件是不是**结构上损坏**的 jar（下载中断、被截断、根本不是 zip）。
 *
 * 与「读不出元数据」是两件事，处理方式也相反：
 * - 损坏 → 删掉重下（而且大概率是下载环节的问题，值得报 warning）
 * - 只是没有元数据（资源包、老 lib 伪装成 .jar）→ 正常现象，info 即可
 *
 * `unzipSync` 遇到坏数据会抛异常，正常 zip 只读中央目录，代价很低。
 */
export function isCorruptZip(jar: Uint8Array): boolean {
  try {
    unzipSync(jar, { filter: () => false })
    return false
  } catch {
    return true
  }
}

export function readModMetadata(
  jar: Uint8Array,
  opts: ReadModMetadataOptions = {},
): ModMetadata | null {
  const order = candidateOrder(opts)
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(jar, {
      filter: (f) => order.includes(f.name) || isNestedJar(f.name),
    })
  } catch {
    return null
  }

  const nested = readNestedJars(entries, order)
  const withNested = (meta: ModMetadata): ModMetadata => ({
    ...meta,
    nested: nested.map((n) => ({ modId: n.modId, version: n.version })),
  })

  for (const name of order) {
    const buf = entries[name]
    if (buf === undefined) continue
    // 这一份读不出来就试下一份：坏掉的 mods.toml 不该让可用的 mcmod.info 一起消失
    const meta = parseCandidate(name, strFromU8(buf))
    if (meta !== null) return withNested(meta)
  }

  /**
   * 顶层没有任何元数据，但 jar-in-jar 里有子模组。
   *
   * Forge 的 `-all` 打包方式就是这样：`kotlinforforge-4.12.0-all.jar` 自己不带
   * `mods.toml`，真正的模组在 `META-INF/jarjar/kffmod-4.12.0.jar` 里。
   * 以前这里直接返回 null，于是 kotlinforforge 永远进不了索引，依赖它的模组
   * 全被误报缺前置（issue #16）。
   *
   * 用第一个子模组当这个 jar 的身份（它的 modId/版本就是依赖方要找的），
   * 其余留在 nested 里。`nestedOnly` 让上层知道「顶层元数据缺失是正常的」，
   * 不再报 UNREADABLE_JAR。
   */
  const primary = nested[0]
  if (primary === undefined) return null
  return {
    modId: primary.modId,
    version: primary.version,
    loader: primary.loader,
    dependencies: [],
    provides: [],
    nested: nested.slice(1).map((n) => ({ modId: n.modId, version: n.version })),
    nestedOnly: true,
  }
}
