import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { runDownloadBatch } from '../download/batch.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadTask, Mirror } from '../download/types.js'
import { Op } from '../events.js'
import { writeInstanceMarker } from '../instance/marker.js'
import { pickLibraries } from '../launch/command.js'
import { detectEnv, type LaunchEnv, type OsArch } from '../launch/env.js'
import type { Layout } from '../layout.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { safeJoin } from '../safe-path.js'
import { fetchVersionJson } from '../version/fetch.js'
import type { Library, VersionFileRef, VersionJson } from '../version/types.js'

export interface VanillaSetupOptions {
  readonly layout: Layout
  readonly versionId: string
  readonly sources?: readonly Mirror[]
  readonly concurrency?: number
  readonly mirror?: boolean
  /** 只打印任务不下载 */
  readonly dryRun?: boolean
}

export interface VanillaSetupResult {
  readonly versionId: string
  readonly total: number
  readonly downloaded: number
  readonly skipped: number
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly nativesExtracted: number
  readonly totalBytes: number
}

/**
 * 原生库的下载条目。
 *
 * 两种时代两种写法：
 * - 1.19+：classifier 写在 name 里（`org.lwjgl:lwjgl:3.4.1:natives-windows`），
 *   `downloads.artifact` 就是那个 jar。
 * - 1.12 及更早：`natives: { windows: "natives-windows" }` +
 *   `downloads.classifiers["natives-windows"]`。只读 artifact 会拿到主 jar（甚至为空），
 *   原生 DLL 永远下不到，启动时报 `UnsatisfiedLinkError: no lwjgl64 in java.library.path`。
 */
export function nativeArtifact(lib: Library, env: LaunchEnv): VersionFileRef | undefined {
  const classifier = lib.natives?.[env.os]
  if (classifier !== undefined) {
    const ref = lib.downloads?.classifiers?.[classifier]
    if (ref !== undefined) return ref
  }
  return lib.downloads?.artifact
}

/**
 * 构造原版安装的下载任务。
 *
 * 三类：client jar、所有 library（普通 + 原生）、assetIndex。
 * 注意 natives jar 也要下——它虽然不进 classpath，但解压时需要文件本体。
 */
export function buildVanillaTasks(
  version: VersionJson,
  env: LaunchEnv,
  layout: Layout,
): DownloadTask[] {
  const tasks: DownloadTask[] = []

  const client = version.downloads?.client
  if (client !== undefined) {
    tasks.push({
      url: client.url,
      fileName: `${version.id}.jar`,
      destPath: layout.clientJar(version.id),
      expectedSize: client.size,
      hashes: { sha1: client.sha1 },
    })
  }

  const { jars, natives } = pickLibraries(version, env)
  for (const lib of jars) {
    const art = lib.downloads?.artifact
    if (art === undefined) continue
    tasks.push({
      url: art.url,
      fileName: basename(art.path),
      destPath: join(layout.libraries, ...art.path.split('/')),
      expectedSize: art.size,
      hashes: { sha1: art.sha1 },
    })
  }
  for (const lib of natives) {
    const art = nativeArtifact(lib, env)
    if (art === undefined) continue
    tasks.push({
      url: art.url,
      fileName: basename(art.path),
      destPath: join(layout.libraries, ...art.path.split('/')),
      expectedSize: art.size,
      hashes: { sha1: art.sha1 },
    })
  }

  if (version.assetIndex !== undefined) {
    tasks.push({
      url: version.assetIndex.url,
      fileName: `${version.assetIndex.id}.json`,
      destPath: layout.assetIndex(version.assetIndex.id),
      expectedSize: version.assetIndex.size,
      hashes: { sha1: version.assetIndex.sha1 },
    })
  }

  return tasks
}

/**
 * 26.x 起 Mojang 把原生库按用途拆进子目录，JVM 参数直接写
 * `-Djava.library.path=${natives_directory}/java`（JNA / Netty 同理）。
 *
 * 仍然把 DLL 全倒进 natives 根目录的话，LWJGL 在 `natives/java` 下找不到
 * `lwjgl.dll`，首启就死在 `UnsatisfiedLinkError: Failed to locate library`。
 * 判断依据用版本 JSON 自己写的参数，不猜版本号。
 */
export function usesSplitNatives(version: VersionJson): boolean {
  const jvm = version.arguments?.jvm ?? []
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是版本 JSON 里的字面量，不是模板
  return jvm.some((a) => typeof a === 'string' && a.includes('${natives_directory}/java'))
}

/** 原生库该落在哪个子目录。老版本（不拆分）一律返回空串，仍解到 natives 根。 */
export function nativeSubdir(lib: Library): string {
  const group = lib.name.split(':')[0] ?? ''
  if (group.startsWith('org.lwjgl')) return 'java'
  if (group.startsWith('net.java.dev.jna')) return 'jna'
  if (group.startsWith('io.netty')) return 'netty'
  return ''
}

/** 解压原生库。跳过 META-INF 和带 .. 的路径（防 zip slip）。 */
export function extractNatives(version: VersionJson, env: LaunchEnv, layout: Layout): number {
  const base = layout.nativesDir(version.id)
  const split = usesSplitNatives(version)
  mkdirSync(base, { recursive: true })
  if (split) {
    // 参数里只引用 java / jna / lwjgl / netty 四个目录。jna 与 netty 是
    // 「自己解压到这里」的临时目录，先把目录建好，省得运行时才报错
    for (const sub of ['java', 'jna', 'lwjgl', 'netty']) {
      mkdirSync(join(base, sub), { recursive: true })
    }
  }

  let count = 0
  const { natives } = pickLibraries(version, env)
  for (const lib of natives) {
    const art = nativeArtifact(lib, env)
    if (art === undefined) continue
    const jarPath = join(layout.libraries, ...art.path.split('/'))
    if (!existsSync(jarPath)) continue
    const dir = split ? join(base, nativeSubdir(lib)) : base

    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(readFileSync(jarPath)))
    } catch {
      continue
    }

    const exclude = lib.extract?.exclude ?? ['META-INF/']
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue
      if (exclude.some((e) => name.startsWith(e))) continue
      const out = safeJoin(dir, name)
      if (out === null) continue
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, data)
      count += 1
    }
  }
  return count
}

/**
 * LWJGL 2 原生库的「扁平文件名 → Windows 加载名」对照。
 *
 * Legacy Fabric 的 `lwjgl-platform` natives jar 里是 `lwjgl-windows-amd64.dll` /
 * `lwjgl-windows-aarch64.dll` / `OpenAL-amd64.dll` 这种带平台后缀的名字——那是它
 * 自己的 SharedLibraryLoader 用的命名。而 `System.loadLibrary("lwjgl")` 在 Windows
 * 上找的是 `lwjgl.dll`：只放 `lwjgl64.dll` 会报 `no lwjgl`（issue #15、#19 实测）。
 */
const LWJGL2_FLAT =
  /^(lwjgl|openal|jinput-dx8|jinput-raw)(?:-[a-z0-9]+)?-(amd64|i386|aarch64)\.dll$/i

/** 文件名里的架构段 ↔ {@link OsArch}。必须精确对上，不能只分 32/64 位。 */
const ARCH_TOKEN: Readonly<Record<OsArch, string>> = {
  x86: 'i386',
  x86_64: 'amd64',
  arm64: 'aarch64',
}

/**
 * 同一个库的加载名。`plain` 是 `System.loadLibrary` 直接找的名字，
 * `wide` 是 64 位约定名（部分代码按 `name + "64"` 拼），两个都写最保险。
 */
const LWJGL2_ALIAS: Readonly<Record<string, { readonly plain: string; readonly wide: string }>> = {
  lwjgl: { plain: 'lwjgl.dll', wide: 'lwjgl64.dll' },
  openal: { plain: 'OpenAL.dll', wide: 'OpenAL64.dll' },
  'jinput-dx8': { plain: 'jinput-dx8.dll', wide: 'jinput-dx8_64.dll' },
  'jinput-raw': { plain: 'jinput-raw.dll', wide: 'jinput-raw_64.dll' },
}

/**
 * 解压时这个原生库该落成哪些名字。`null` 表示不是当前架构的那一份，不要写。
 *
 * 架构必须**精确**匹配：x64 机器上拿到 aarch64 的 DLL 时，改名只会把
 * `no lwjgl` 换成 `Can't load ARM 64-bit .dll on a AMD 64-bit platform`（issue #19）。
 *
 * 只认 Windows 的 `.dll`：其他平台的原生库本来就叫 `liblwjgl.so` 之类，
 * 按这套规则改名只会帮倒忙。
 */
export function legacyNativeNames(name: string, arch: OsArch): string[] | null {
  const m = LWJGL2_FLAT.exec(name)
  if (m === null) return [name]
  const base = m[1]?.toLowerCase() ?? ''
  const alias = LWJGL2_ALIAS[base]
  if (alias === undefined) return [name]
  if (m[2]?.toLowerCase() !== ARCH_TOKEN[arch]) return null
  // 32 位只写 plain：`lwjgl64.dll` 里放 32 位二进制只会让排查更乱
  return arch === 'x86' ? [alias.plain] : [alias.plain, alias.wide]
}

/**
 * 把一批原生 jar 解压到 destDir。
 *
 * 给「profile 只写了裸 maven 坐标」的加载器用（Legacy Fabric 的 lwjgl-platform）：
 * 那种库没有 downloads 元数据，`extractNatives` 按 downloads 找不到 jar 路径，
 * 只能由下载侧告诉我们落盘在哪。
 *
 * `arch` 给了就顺手把 LWJGL 2 的扁平文件名改成加载名（见 {@link legacyNativeNames}）。
 */
export function extractNativeJars(
  jars: readonly string[],
  destDir: string,
  opts: { readonly exclude?: readonly string[]; readonly arch?: OsArch } = {},
): number {
  const exclude = opts.exclude ?? ['META-INF/']
  mkdirSync(destDir, { recursive: true })
  let count = 0
  for (const jar of jars) {
    if (!existsSync(jar)) continue
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(readFileSync(jar)))
    } catch {
      continue
    }
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue
      if (exclude.some((e) => name.startsWith(e))) continue
      // 只保留当前架构那一份，避免同目录里堆着三个架构的 lwjgl
      const targets = opts.arch === undefined ? [name] : legacyNativeNames(name, opts.arch)
      if (targets === null) continue
      for (const target of targets) {
        const out = safeJoin(destDir, target)
        if (out === null) continue
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, data)
        count += 1
      }
    }
  }
  return count
}

export function createVanillaSetup(opts: VanillaSetupOptions): Operation<VanillaSetupResult> {
  return defineOperation<VanillaSetupResult>('vanilla-setup', async function* (signal) {
    const env = detectEnv()
    const version = await fetchVersionJson(opts.versionId, {
      ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
      signal,
    })

    const tasks = buildVanillaTasks(version, env, opts.layout)
    const totalBytes = tasks.reduce((s, t) => s + t.expectedSize, 0)

    yield Op.log('info', 'setup.tasks', {
      tasks: tasks.length,
      totalBytes,
      version: version.id,
    })

    if (opts.dryRun === true) {
      yield Op.result({
        versionId: version.id,
        total: tasks.length,
        downloaded: 0,
        skipped: 0,
        failed: [],
        nativesExtracted: 0,
        totalBytes,
      })
      yield Op.done()
      return
    }

    const sources = opts.sources ?? defaultSources()
    const concurrency = opts.concurrency ?? 4

    // 把版本 JSON 落盘。它是 `launch` 唯一的本地依据：不写的话，下次启动即使
    // 文件全在也要回源拉一次，断网就起不来（加载器版本还要沿 inheritsFrom 找父版本）。
    const versionJsonPath = opts.layout.versionJson(version.id)
    mkdirSync(dirname(versionJsonPath), { recursive: true })
    writeFileSync(versionJsonPath, `${JSON.stringify(version, null, 2)}\n`, 'utf8')
    yield Op.log('info', 'setup.version_json', { path: versionJsonPath })

    const { downloaded, skipped, bytes, failed } = yield* runDownloadBatch({
      tasks,
      sources,
      concurrency,
      signal,
      codes: {
        ok: 'setup.ok',
        cached: 'setup.cached',
        failed: 'setup.failed',
        progressId: 'setup',
      },
    })

    const nativesExtracted = extractNatives(version, env, opts.layout)
    yield Op.log('info', 'setup.natives', { extracted: nativesExtracted })

    // 让 `preflight <实例目录>` 知道这是哪个游戏版本。只有 Prism 的实例有这份文件，
    // 自己装的反而查不出 MC 版本，说不通。
    const markerPath = writeInstanceMarker(opts.layout.gameDir, { gameVersion: version.id })
    yield Op.log('info', 'setup.marker', { path: markerPath })

    yield Op.result({
      versionId: version.id,
      total: tasks.length,
      downloaded,
      skipped,
      failed,
      nativesExtracted,
      totalBytes: bytes,
    })
    yield Op.done()
  })
}
