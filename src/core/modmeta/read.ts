import { strFromU8, unzipSync } from 'fflate'
import { parse as parseToml } from 'smol-toml'

import type { LoaderKind } from '../instance.js'
import type { ModDependency, ModLoaderKind, ModMetadata } from './types.js'

const FABRIC = 'fabric.mod.json'
const QUILT = 'quilt.mod.json'
const NEOFORGE = 'META-INF/neoforge.mods.toml'
const FORGE = 'META-INF/mods.toml'
/**
 * 1.12.2 及更早的 Forge 元数据。1.13+ 不再读它，所以「jar 里有 mcmod.info」
 * 基本可以判定这是个老版本模组——反过来，老 jar 里带一份多余的 mods.toml 却很常见
 * （作者复用了 1.13 的构建模板），RLCraft 里的 SpartanShields 就是这种。
 */
const MCMOD = 'mcmod.info'
/** Fabric 用 JiJ（jars/），Forge 用 JarJar（jarjar/）。两套前缀都要扫。 */
const JIJ_PREFIXES = ['META-INF/jars/', 'META-INF/jarjar/'] as const

function isNestedJar(name: string): boolean {
  return JIJ_PREFIXES.some((p) => name.startsWith(p)) && name.endsWith('.jar')
}

/** 按加载器优先级排列。多加载器 jar 里 fabric 声明通常最准确。 */
const CANDIDATES = [FABRIC, QUILT, NEOFORGE, FORGE, MCMOD] as const

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

function parseCandidate(name: string, text: string): ModMetadata | null {
  if (name === FABRIC) return fromFabric(text)
  if (name === QUILT) return fromQuilt(text)
  if (name === MCMOD) return fromMcmodInfo(text)
  return fromForgeToml(text, name === NEOFORGE ? 'neoforge' : 'forge')
}

type TomlShape = {
  modLoader?: string
  loaderVersion?: string
  mods?: Array<{
    modId?: string
    version?: string
    displayName?: string
    provides?: unknown
  }>
  dependencies?: Record<
    string,
    Array<{
      modId?: string
      /** 1.13–1.20.4 的写法 */
      mandatory?: boolean
      /**
       * NeoForge 1.20.5+ 改用 `type = "required|optional|incompatible"`，
       * 不再写 `mandatory`。不认它会把可选依赖当成必需，报出假的 MISSING_DEPENDENCY。
       */
      type?: string
      versionRange?: string
    }>
  >
}

function normDep(
  modId: string,
  mandatory: boolean,
  range?: string,
  kind?: 'breaks',
): ModDependency {
  return {
    modId,
    mandatory,
    ...(range === undefined || range === '' ? {} : { versionRange: range }),
    ...(kind === undefined ? {} : { kind }),
  }
}

/** Fabric 的 depends 值可能是字符串，也可能是数组（表示 or 关系）。 */
function flattenFabricRange(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(' || ')
  return undefined
}

/**
 * 把字符串字面量里的裸控制字符转义。
 *
 * 真实模组里确实存在这种文件：description 写成多行，换行直接落在 JSON 字符串里。
 * 严格 JSON 不允许，但 Fabric 用的是 Gson（lenient），游戏里能正常加载。
 * 我们只做这一处修补——不实现完整的宽松解析器，避免把坏文件「修」成另一个意思。
 */
function escapeControlCharsInStrings(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (escaped) {
      out += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      out += ch
      escaped = true
      continue
    }
    if (ch === '"') {
      out += ch
      inString = false
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * 解析 mod 元数据里的 JSON。先按严格标准来，失败再放过裸控制字符。
 *
 * 不这么做的话，`fabric.mod.json` 里一个换行就让整个模组从检查里消失——
 * 用户看到的是「读不出元数据」，看不到的是「这个模组再也不会被检查」。
 */
function parseModJson(text: string): Record<string, unknown> | null {
  const trimmed = text.replace(/^\uFEFF/, '')
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    // fallthrough：Fabric 的解析器比 JSON.parse 宽松
  }
  try {
    return JSON.parse(escapeControlCharsInStrings(trimmed)) as Record<string, unknown>
  } catch {
    return null
  }
}

function fromFabric(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const id = raw.id
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const depends = raw.depends
  if (depends !== null && typeof depends === 'object') {
    for (const [modId, range] of Object.entries(depends as Record<string, unknown>)) {
      deps.push(normDep(modId, true, flattenFabricRange(range)))
    }
  }

  const breaks = raw.breaks
  if (breaks !== null && typeof breaks === 'object') {
    for (const [modId, range] of Object.entries(breaks as Record<string, unknown>)) {
      deps.push(normDep(modId, false, flattenFabricRange(range), 'breaks'))
    }
  }

  const provides: string[] = []
  const rawProvides = raw.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) if (typeof p === 'string') provides.push(p)
  }

  const version = typeof raw.version === 'string' ? raw.version : 'unknown'
  const name = typeof raw.name === 'string' ? raw.name : undefined
  const mc = deps.find((d) => d.modId === 'minecraft')
  const fl = deps.find((d) => d.modId === 'fabricloader')

  return {
    modId: id,
    version,
    ...(name === undefined ? {} : { name }),
    loader: 'fabric',
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    ...(fl?.versionRange === undefined ? {} : { loaderVersionRange: fl.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
  }
}

function fromQuilt(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const ql = raw.quilt_loader
  if (ql === null || typeof ql !== 'object') return null
  const node = ql as Record<string, unknown>
  const id = node.id
  if (typeof id !== 'string' || id === '') return null

  const deps: ModDependency[] = []
  const rawDeps = node.depends
  if (Array.isArray(rawDeps)) {
    for (const d of rawDeps) {
      if (d !== null && typeof d === 'object') {
        const item = d as Record<string, unknown>
        const depId = item.id
        if (typeof depId === 'string') {
          const versions = item.versions
          deps.push(normDep(depId, true, typeof versions === 'string' ? versions : undefined))
        }
      }
    }
  }

  const version = typeof node.version === 'string' ? node.version : 'unknown'
  const mc = deps.find((d) => d.modId === 'minecraft')

  const provides: string[] = []
  const rawProvides = node.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) {
      if (p !== null && typeof p === 'object') {
        const pid = (p as Record<string, unknown>).id
        if (typeof pid === 'string') provides.push(pid)
      }
    }
  }

  return {
    modId: id,
    version,
    loader: 'quilt',
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
  }
}

/** 1.12.2 的 mcmod.info：可能是数组、`{ modList: [...] }`，也可能是单个对象。 */
type McmodEntry = {
  modid?: string
  name?: string
  version?: string
  mcversion?: string
  dependencies?: unknown
}

function mcmodEntries(raw: Record<string, unknown>): McmodEntry[] {
  if (Array.isArray(raw)) return raw as McmodEntry[]
  const list = raw.modList
  if (Array.isArray(list)) return list as McmodEntry[]
  return [raw as McmodEntry]
}

function pickMcmodEntry(raw: Record<string, unknown>): McmodEntry | null {
  return mcmodEntries(raw)[0] ?? null
}

/** mcversion 可能是 `1.12.2`、`1.12`、`1.12.x`，也可能是 `[1.12.2,1.13)`。统一成范围表达式。 */
function asRange(mcversion: string): string {
  const v = mcversion.trim()
  if (/^[[(]/.test(v)) return v
  // 1.12.x / 1.12.* 都是「1.12 这一代」，先去掉通配段再当前缀处理
  const cleaned = v.replace(/\.(x|X|\*)$/, '')
  const parts = cleaned.split('.')
  if (parts.length === 2) {
    const next = Number(parts[1]) + 1
    return `>=${cleaned} <${parts[0]}.${next}`
  }
  return `[${cleaned}]`
}

/**
 * 1.12.2 的依赖写法：`required-after:modid[@[1.0,)]`、`after:modid`、`optional:modid`。
 *
 * 注意：`mcmod.info` 里的 dependencies **不是 Forge 的硬依赖**——真正生效的是
 * `@Mod(dependencies=...)` 注解，这份只是模组列表的展示信息，作者常年不维护。
 * 实证：RLCraft 2.9.3 里 WolfArmor 声明了三个不存在的前置（twilightforest 等），
 * 这个包照样能进游戏。把它们当 required 会让每个 1.12.2 整合包满屏假 blocker。
 *
 * 所以全部记为 non-mandatory：保留信息，不参与「缺没缺」的判定。
 */
function parseForgeDeps(raw: unknown): ModDependency[] {
  if (!Array.isArray(raw)) return []
  const out: ModDependency[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    // 一个数组项就是一条依赖。**不能按逗号切**：`@[1.0,)` 里的逗号是版本范围的一部分，
    // 切完会多出一个叫 ")" 的模组（RLCraft 的 betternether 就是这样）。
    for (const part of item.split(';')) {
      const token = part.trim()
      if (token === '') continue
      const colon = token.indexOf(':')
      const kind = (colon === -1 ? 'required' : token.slice(0, colon)).trim().toLowerCase()
      const rest = colon === -1 ? token : token.slice(colon + 1).trim()
      const at = rest.indexOf('@')
      // Forge 的 modId 一律小写；mcmod.info 里常写成 ForgeEndertech / Forge
      const modId = (at === -1 ? rest : rest.slice(0, at)).trim().toLowerCase()
      const range = at === -1 ? undefined : rest.slice(at + 1).trim()
      if (modId === '') continue
      if (kind === 'before' || kind === 'after' || kind === 'optional') continue
      out.push(normDep(modId, false, range === '' ? undefined : range))
    }
  }
  return out
}

function fromMcmodInfo(text: string): ModMetadata | null {
  const raw = parseModJson(text)
  if (raw === null) return null
  const entries = mcmodEntries(raw)
  const entry = pickMcmodEntry(raw)
  if (entry === null || typeof entry.modid !== 'string' || entry.modid === '') return null

  // 一个 jar 声明多个 mod 时，主 modId 之外的也要能被依赖匹配上，否则会报假缺前置
  const provides: string[] = []
  for (const extra of entries.slice(1)) {
    if (typeof extra.modid === 'string' && extra.modid !== '' && !provides.includes(extra.modid)) {
      provides.push(extra.modid)
    }
  }

  const deps = parseForgeDeps(entry.dependencies)
  const mc =
    typeof entry.mcversion === 'string' && entry.mcversion !== '' ? entry.mcversion : undefined

  return {
    modId: entry.modid,
    version: typeof entry.version === 'string' ? entry.version : 'unknown',
    ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}),
    loader: 'forge',
    // mcversion 同样只是展示信息，放进字段供人参考，不升级成 minecraft 依赖
    ...(mc === undefined ? {} : { mcVersionRange: asRange(mc) }),
    dependencies: deps,
    provides,
    nested: [],
  }
}

function fromForgeToml(text: string, loader: ModLoaderKind): ModMetadata | null {
  let raw: TomlShape
  try {
    raw = parseToml(text) as TomlShape
  } catch {
    return null
  }
  const mods = raw.mods ?? []
  const first = mods[0]
  if (first === undefined || typeof first.modId !== 'string') return null

  /**
   * 一个 jar 可以声明多个 `[[mods]]`（常见于前置打包）。只读 `[0]` 会让后面那些
   * modId 的依赖永远匹配不上，报出假的 MISSING_DEPENDENCY。
   */
  const declaredIds = mods
    .map((m) => m.modId)
    .filter((id): id is string => typeof id === 'string' && id !== '')
  const depsRaw = mods.flatMap((m) =>
    typeof m.modId === 'string' ? (raw.dependencies?.[m.modId] ?? []) : [],
  )
  const deps: ModDependency[] = []
  const seen = new Set<string>()
  for (const d of depsRaw) {
    if (typeof d.modId !== 'string') continue
    const key = `${d.modId}|${d.versionRange ?? ''}|${d.type ?? ''}|${String(d.mandatory)}`
    if (seen.has(key)) continue
    seen.add(key)
    /**
     * `mandatory` 优先（老写法显式给了就以它为准）；否则看 `type`。
     * `incompatible` 不是「必需」，不能因为它不在实例里就报缺依赖。
     */
    const mandatory =
      d.mandatory !== undefined
        ? d.mandatory
        : d.type === undefined
          ? true
          : d.type.toLowerCase() === 'required'
    deps.push(
      normDep(
        d.modId,
        mandatory,
        d.versionRange,
        d.type?.toLowerCase() === 'incompatible' ? 'breaks' : undefined,
      ),
    )
  }

  const mc = deps.find((d) => d.modId === 'minecraft')
  const fl = deps.find((d) => d.modId === 'forge' || d.modId === 'neoforge')

  /**
   * Forge 的 `[[mods]]` 也有 `provides`，只是**必须加引号写成数组**：
   *
   *   [[mods]]
   *     modId = "fabric_api"
   *     provides = ["fabric", "fabric-api"]
   *
   * 这在 Sinytra Connector 生态里是通行做法——Forgified Fabric API 就靠它
   * 让 `fabric` / `fabric-api` 这些依赖能匹配上 `fabric_api`。
   * 早期版本这里写的是 `provides: []`，注释还写着「Forge 没有 provides 概念」，
   * 那是错的：BMC4（229 万下载）因此整包被判 BLOCKED。
   */
  const provides: string[] = []
  const rawProvides = first.provides
  if (Array.isArray(rawProvides)) {
    for (const p of rawProvides) if (typeof p === 'string' && p !== '') provides.push(p)
  } else if (typeof rawProvides === 'string' && rawProvides !== '') {
    // 单个字符串也接受（Toml 里写 provides = "x" 的情况）
    provides.push(rawProvides)
  }
  // 同一个 jar 里其余 [[mods]] 的 modId 也算「本 jar 提供了它」
  for (const id of declaredIds.slice(1)) {
    if (!provides.includes(id)) provides.push(id)
  }

  return {
    modId: first.modId,
    version: typeof first.version === 'string' ? first.version : 'unknown',
    ...(first.displayName === undefined ? {} : { name: first.displayName }),
    loader,
    ...(mc?.versionRange === undefined ? {} : { mcVersionRange: mc.versionRange }),
    ...(fl?.versionRange === undefined ? {} : { loaderVersionRange: fl.versionRange }),
    dependencies: deps,
    provides,
    nested: [],
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
