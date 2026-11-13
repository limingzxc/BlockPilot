/** jar 内元数据文件的固定位置与识别规则。 */

export const FABRIC = 'fabric.mod.json'
export const QUILT = 'quilt.mod.json'
export const NEOFORGE = 'META-INF/neoforge.mods.toml'
export const FORGE = 'META-INF/mods.toml'
/**
 * 1.12.2 及更早的 Forge 元数据。1.13+ 不再读它，所以「jar 里有 mcmod.info」
 * 基本可以判定这是个老版本模组——反过来，老 jar 里带一份多余的 mods.toml 却很常见
 * （作者复用了 1.13 的构建模板），RLCraft 里的 SpartanShields 就是这种。
 */
export const MCMOD = 'mcmod.info'

/** Fabric 用 JiJ（jars/），Forge 用 JarJar（jarjar/）。两套前缀都要扫。 */
export const JIJ_PREFIXES = ['META-INF/jars/', 'META-INF/jarjar/'] as const

export function isNestedJar(name: string): boolean {
  return JIJ_PREFIXES.some((p) => name.startsWith(p)) && name.endsWith('.jar')
}

/** 按加载器优先级排列。多加载器 jar 里 fabric 声明通常最准确。 */
export const CANDIDATES = [FABRIC, QUILT, NEOFORGE, FORGE, MCMOD] as const
