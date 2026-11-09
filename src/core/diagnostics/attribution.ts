/**
 * 把栈帧和日志里的归属线索，归到具体的模组上。
 *
 * 证据分三档，强度从高到低：
 *
 * 1. **日志自己写的**——Forge 在帧尾附 jar 名，Fabric 在 mixin 处理器方法名里嵌 mod id，
 *    mixin 报错会打印 `<modid>.mixins.json`。这些是事实，不需要推断。
 * 2. **jar 里的类**——包名属于哪个 jar，扫一眼 jar 的条目就知道。这也是事实，
 *    但「包名属于模组」不等于「这段代码就是它执行的」（可能是它内嵌的库）。
 * 3. **什么都不确定时就不说**。宁可报告「定位不到具体模组」，也不能指错人——
 *    指错一个模组，用户会去删它，然后问题依旧，还多了一个新问题。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { unzipSync } from 'fflate'

import { readModMetadata } from '../modmeta/read.js'
import type { StackFrame } from './frames.js'
import { jarNameOf, parseFrames, rootCauseStart } from './frames.js'

export interface ModRef {
  readonly modId: string
  readonly name?: string
  readonly version?: string
  readonly fileName: string
}

export interface ModIndex {
  /** 包前缀（`com/example/mod`）→ 声明它的 modId。多个模组共用时保留多个 */
  readonly byPackage: ReadonlyMap<string, readonly string[]>
  /** jar 文件名（小写）→ modId */
  readonly byFileName: ReadonlyMap<string, string>
  readonly mods: ReadonlyMap<string, ModRef>
}

export interface Culprit {
  readonly modId: string
  readonly name?: string
  readonly version?: string
  readonly fileName: string
  readonly score: number
  /** 归到这个模组的帧数 */
  readonly frames: number
  /** 最上面那一帧的行号 */
  readonly firstFrameLine: number
  /** 代表性的一帧，给用户看原文 */
  readonly sampleFrame: string
  /** 判定依据，人能读懂的一句话，已按类别归并 */
  readonly reasons: readonly string[]
}

export interface Attribution {
  readonly culprits: readonly Culprit[]
  /** 找到了帧但归不到模组时的说明，用于告诉用户「为什么定位不到」 */
  readonly notes: readonly string[]
}

/**
 * 这些包不属于任何模组，或者模组只是把它们原样打包进来。
 *
 * 不做这个过滤的后果很具体：某个模组内嵌了 fastutil，于是
 * `it.unimi.dsi.fastutil.*` 的所有帧都会算到它头上，而真正的调用方是原版。
 */
const PLATFORM_PREFIXES: readonly string[] = [
  'java/',
  'javax/',
  'jdk/',
  'sun/',
  'com/sun/',
  'com/oracle/',
  'net/minecraft/',
  'com/mojang/',
  'net/minecraftforge/',
  'net/neoforged/',
  'cpw/mods/',
  'net/fabricmc/',
  'org/quiltmc/',
  'org/spongepowered/',
  'org/lwjgl/',
]

/** 常见的内嵌库。出现在任何一个 mod jar 里都不代表那是它的代码。 */
const BUNDLED_LIBRARIES: readonly string[] = [
  'org/apache/',
  'com/google/',
  'org/jetbrains/',
  'kotlin/',
  'kotlinx/',
  'org/slf4j/',
  'io/netty/',
  'org/objectweb/',
  'it/unimi/',
  'org/joml/',
  'com/electronwill/',
  'org/yaml/',
  'com/github/',
  'org/intellij/',
  'org/jspecify/',
  'org/checkerframework/',
  'com/ibm/',
  'oshi/',
  'net/java/',
  'org/jsoup/',
]

function isPlatform(pkg: string): boolean {
  const withSlash = `${pkg}/`
  return (
    PLATFORM_PREFIXES.some((p) => withSlash.startsWith(p)) ||
    BUNDLED_LIBRARIES.some((p) => withSlash.startsWith(p))
  )
}

/**
 * 条目的完整包路径：`net/caffeinemc/mods/sodium/client/render/Foo.class`
 * → `net/caffeinemc/mods/sodium/client/render`。
 *
 * 曾经截断到三段，结果是 `net/caffeinemc/mods` 同时属于 sodium 和 lithium，
 * 于是这两个模组的栈帧**全部**因为「包名有歧义」被丢弃——真实实例上一测就露馅。
 * 完整路径才能把 `.../mods/sodium` 和 `.../mods/lithium` 分开。
 */
function packageOf(entry: string): string | null {
  if (!entry.endsWith('.class')) return null
  if (entry.startsWith('META-INF/')) return null
  const dir = entry.slice(0, entry.lastIndexOf('/'))
  if (dir === '') return null
  const parts = dir.split('/')
  if (parts.length < 2) return null
  return dir
}

/**
 * 嵌套 jar 的两种前缀：Fabric 叫 JiJ（`META-INF/jars/`），
 * Forge 叫 JarJar（`META-INF/jarjar/`）。和 modmeta/read.ts 里同一套规则。
 */
function isNestedJarPath(name: string): boolean {
  return (
    (name.startsWith('META-INF/jars/') || name.startsWith('META-INF/jarjar/')) &&
    name.endsWith('.jar')
  )
}

/**
 * 扫一遍 mods 目录，建「包名 → 模组」和「jar 名 → 模组」两张表。
 *
 * 只读 zip 的中央目录，不解压任何条目——`filter` 返回 false 时 fflate 会
 * 跳过解压，所以几百 MB 的模组目录也只是读一遍文件。
 */
export function buildModIndex(modsDir: string): ModIndex {
  const byPackage = new Map<string, string[]>()
  const byFileName = new Map<string, string>()
  const mods = new Map<string, ModRef>()

  let names: string[]
  try {
    names = readdirSync(modsDir)
  } catch {
    return { byPackage, byFileName, mods }
  }

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.jar')) continue
    const full = join(modsDir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch {
      continue
    }

    let buf: Uint8Array
    try {
      buf = new Uint8Array(readFileSync(full))
    } catch {
      continue
    }

    const meta = readModMetadata(buf)
    // 读不出元数据的 jar（资源包、损坏文件）不参与归属：它连名字都没有
    if (meta === null) continue

    const ref: ModRef = {
      modId: meta.modId,
      ...(meta.name === undefined ? {} : { name: meta.name }),
      version: meta.version,
      fileName: name,
    }
    mods.set(meta.modId, ref)
    byFileName.set(name.toLowerCase(), meta.modId)

    const prefixes = new Set<string>()
    try {
      unzipSync(buf, {
        filter: (f) => {
          const p = packageOf(f.name)
          if (p !== null && !isPlatform(p)) prefixes.add(p)
          return false
        },
      })
    } catch {
      // 中央目录坏了。文件名与元数据仍然可用，只是少了包名归属
    }

    // 嵌套 jar 里的类也算给外层模组。Fabric API 的 57 个子模块全在
    // META-INF/jars/ 里，不扫这一层的话，它们的栈帧一帧都归不到 fabric-api。
    // 代价是要真的解压这些内层 jar——外层只读中央目录是不够的。
    let innerJars: Record<string, Uint8Array>
    try {
      innerJars = unzipSync(buf, { filter: (f) => isNestedJarPath(f.name) })
    } catch {
      innerJars = {}
    }
    for (const data of Object.values(innerJars)) {
      try {
        unzipSync(data, {
          filter: (f) => {
            const p = packageOf(f.name)
            if (p !== null && !isPlatform(p)) prefixes.add(p)
            return false
          },
        })
      } catch {
        // 内层 jar 坏了不影响外层
      }
    }

    for (const p of prefixes) {
      const list = byPackage.get(p)
      if (list === undefined) byPackage.set(p, [meta.modId])
      else if (!list.includes(meta.modId)) list.push(meta.modId)
    }
  }

  return { byPackage, byFileName, mods }
}

/** mixin 报错里的配置名：`sodium.mixins.json:LightmapTextureManagerMixin` */
const MIXIN_CONFIG_RE = /\b([a-z0-9_]{2,})\.mixins\.json\b/

/** 空索引，用于「没有 mods 目录」的场景，避免调用方写 if */
export const EMPTY_INDEX: ModIndex = {
  byPackage: new Map(),
  byFileName: new Map(),
  mods: new Map(),
}

interface Accumulator {
  score: number
  frames: number
  firstFrameLine: number
  sampleFrame: string
  packages: Set<string>
  mixinIds: Set<string>
  jars: Set<string>
  configs: Set<string>
  atRoot: boolean
}

type Evidence =
  | { readonly kind: 'jar'; readonly jar: string }
  | { readonly kind: 'mixin' }
  | { readonly kind: 'package'; readonly pkg: string }
  | { readonly kind: 'config'; readonly config: string }
  | { readonly kind: 'root' }

interface AttributeInput {
  readonly lines: readonly string[]
  readonly index: ModIndex
  /** 不传就现场解析 */
  readonly frames?: readonly StackFrame[]
}

/** 包名归属。返回 null 表示这帧不属于任何可识别的模组。 */
function modOfClass(className: string, index: ModIndex): { modId: string; pkg: string } | null {
  const parts = className.split('.')
  // 从完整包路径往短里试，命中即止。先长后短很关键：
  // `net/caffeinemc/mods` 有两个模组共用，而 `net/caffeinemc/mods/sodium` 只有一个
  for (let n = parts.length - 1; n >= 2; n -= 1) {
    const prefix = parts.slice(0, n).join('/')
    const owners = index.byPackage.get(prefix)
    if (owners === undefined) continue
    // 多个模组都声明了这个包，说明它可能是共用库，不能据此指认
    if (owners.length !== 1) return null
    const modId = owners[0]
    if (modId === undefined) return null
    return { modId, pkg: parts.slice(0, n).join('.') }
  }
  return null
}

export function attributeCulprits(input: AttributeInput): Attribution {
  const { lines, index } = input
  const frames = input.frames ?? parseFrames(lines)
  const rootStart = rootCauseStart(lines) + 1
  const acc = new Map<string, Accumulator>()
  const notes: string[] = []

  const touch = (modId: string, line: number, frameText: string): Accumulator | null => {
    if (!index.mods.has(modId)) return null
    let a = acc.get(modId)
    if (a === undefined) {
      a = {
        score: 0,
        frames: 0,
        firstFrameLine: line,
        sampleFrame: frameText,
        packages: new Set(),
        mixinIds: new Set(),
        jars: new Set(),
        configs: new Set(),
        atRoot: false,
      }
      acc.set(modId, a)
    }
    if (line < a.firstFrameLine) {
      a.firstFrameLine = line
      a.sampleFrame = frameText
    }
    return a
  }

  let primaryAssigned = false
  let unattributedInRoot = 0

  for (const frame of frames) {
    const frameText =
      `at ${frame.className}.${frame.method}` +
      (frame.sourceFile === undefined ? '' : `(${frame.sourceFile}:${frame.sourceLine ?? '?'})`)

    let modId: string | null = null
    let evidence: Evidence | null = null
    let weight = 0

    // 1. 帧尾的 jar 名。这是运行时的真实来源，最可靠
    if (frame.sourceJar !== undefined) {
      const owner = index.byFileName.get(frame.sourceJar.toLowerCase())
      if (owner !== undefined) {
        modId = owner
        evidence = { kind: 'jar', jar: frame.sourceJar }
        weight = 50
      }
    }

    // 2. Fabric mixin 处理器方法名里的 mod id
    if (modId === null && frame.mixinModId !== undefined) {
      if (index.mods.has(frame.mixinModId)) {
        modId = frame.mixinModId
        evidence = { kind: 'mixin' }
        weight = 60
      }
    }

    // 3. 包名
    if (modId === null) {
      const byPkg = modOfClass(frame.className, index)
      if (byPkg !== null) {
        modId = byPkg.modId
        evidence = { kind: 'package', pkg: byPkg.pkg }
        weight = 10
      }
    }

    if (modId === null) {
      if (frame.line >= rootStart) unattributedInRoot += 1
      continue
    }

    const a = touch(modId, frame.line, frameText)
    if (a === null) continue
    a.frames += 1
    a.score += weight

    if (evidence !== null) {
      switch (evidence.kind) {
        case 'jar':
          a.jars.add(evidence.jar)
          break
        case 'package':
          a.packages.add(evidence.pkg)
          break
        case 'mixin':
          a.mixinIds.add(modId)
          break
        default:
          break
      }
    }

    // 根因区段里最上面的那一帧，是抛出点所在。权重压倒性地高
    if (!primaryAssigned && frame.line >= rootStart) {
      a.score += 100
      a.atRoot = true
      primaryAssigned = true
    }
  }

  // 4. 日志正文里的 mixin 配置名。通常是「XX 的 mixin 应用失败」的确切主语
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === undefined) continue
    const m = MIXIN_CONFIG_RE.exec(line)
    if (m === null) continue
    const modId = m[1]
    if (modId === undefined) continue
    const a = touch(modId, i + 1, line.trim())
    if (a === null) continue
    a.configs.add(modId)
    a.score += 40
  }

  const culprits: Culprit[] = []
  for (const [modId, a] of acc) {
    const ref = index.mods.get(modId)
    if (ref === undefined) continue

    const reasons: string[] = []
    // 按证据强度排序，CLI 只显示前几条，所以最硬的必须排在最前
    if (a.atRoot) reasons.push('根因区段最上面的一帧')
    if (a.jars.size > 0) reasons.push(`栈帧标明了来源 ${[...a.jars].join('、')}`)
    if (a.mixinIds.size > 0) reasons.push('mixin 处理器方法名里带了它的 mod id')
    if (a.configs.size > 0) reasons.push(`日志里点名了 ${modId}.mixins.json`)
    if (a.packages.size > 0) {
      const shown = [...a.packages].slice(0, 2).join('、')
      const more = a.packages.size > 2 ? ' 等' : ''
      reasons.push(`包名属于它：${shown}${more}`)
    }

    culprits.push({
      modId,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.version === undefined ? {} : { version: ref.version }),
      fileName: ref.fileName,
      score: a.score,
      frames: a.frames,
      firstFrameLine: a.firstFrameLine,
      sampleFrame: a.sampleFrame,
      reasons,
    })
  }
  culprits.sort((x, y) => y.score - x.score)

  if (frames.length === 0) {
    notes.push('日志里没有栈帧，无法定位到具体模组')
  } else if (index.mods.size === 0) {
    notes.push('没有读到任何模组元数据（mods 目录为空或不存在），无法把栈帧归到模组')
  } else if (culprits.length === 0) {
    notes.push(
      `解析到 ${frames.length} 个栈帧，但没有一个能归到已安装的模组——异常可能来自原版或某个库`,
    )
  } else if (unattributedInRoot > 0 && !primaryAssigned) {
    notes.push(`根因区段有 ${unattributedInRoot} 帧不属于任何模组`)
  }

  return { culprits, notes }
}

/** 从 jar 文件名反查 modId，供调用方处理别的日志格式时复用 */
export function modIdOfJar(index: ModIndex, jarName: string): string | null {
  const name = jarNameOf(jarName) ?? jarName
  return index.byFileName.get(name.toLowerCase()) ?? null
}
