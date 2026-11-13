import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { basename, dirname } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import type { CfFileInfo } from '../curseforge.js'
import { isForgeCdnUrl } from '../curseforge.js'
import type { DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import type { CurseforgeManifest } from '../pack/curseforge.js'
import type { MrpackIndex } from '../pack/mrpack.js'
import { safeJoin } from '../safe-path.js'

/**
 * 服务端专用的文件不该装到客户端。
 *
 * mrpack 的 env 语义：`client: "unsupported"` + `server: "required"` 表示
 * 这个文件只有服务端要。装进客户端轻则浪费，重则崩溃。
 */
function isClientRelevant(file: MrpackIndex['files'][number]): boolean {
  const client = file.env?.client
  if (client === 'unsupported') return false
  return true
}

/**
 * 从 Modrinth CDN 地址反推 projectId / versionId。
 *
 * mrpack 的清单只有 `path` + `downloads`，没有 projectId；但规范要求
 * 下载地址走 `cdn.modrinth.com/data/<pid>/versions/<vid>/<file>`，
 * 所以这一层信息是现成的，不该再要求调用方去查一次 API。
 */
function modrinthMeta(url: string): DownloadTask['meta'] | undefined {
  const m = /cdn\.modrinth\.com\/data\/([\w-]+)\/versions\/([\w-]+)\//.exec(url)
  const projectId = m?.[1]
  const versionId = m?.[2]
  return projectId === undefined || versionId === undefined
    ? undefined
    : { projectId, versionId, source: 'modrinth' }
}

export function buildPackTasks(
  index: MrpackIndex,
  layout: Layout,
  opts: PackTaskOptions = {},
): PackTaskBuild {
  const tasks: DownloadTask[] = []
  const rejected: { fileName: string; error: string }[] = []
  const allowed = new Set([
    ...MODRINTH_ALLOWED_HOSTS.map((h) => h.toLowerCase()),
    ...(opts.allowHosts ?? []).map((h) => h.toLowerCase()),
  ])

  for (const file of index.files) {
    if (!isClientRelevant(file)) continue
    const url = file.downloads[0]
    const fileName = basename(file.path)
    // 没有下载地址不能静默跳过：deploy 会以为全部装好，用户进游戏才发现少模组
    if (url === undefined) {
      rejected.push({ fileName, error: '清单里这一项没有下载地址' })
      continue
    }

    // 路径穿越在这里挡住：清单是外部输入，`../../evil.jar` 能把文件甩到实例外
    const destPath = safeJoin(layout.gameDir, file.path)
    if (destPath === null) {
      rejected.push({ fileName, error: `清单里的路径不安全：${file.path}` })
      continue
    }

    /**
     * Modrinth 规范限制了下载域名。哈希能保证内容正确，但挡不住恶意包让
     * 用户机器去请求内网地址（SSRF）。白名单之外的文件不下载，但要报出来，
     * 不能静默少装一个模组。
     */
    let host: string
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      rejected.push({ fileName, error: `下载地址不是合法 URL：${url}` })
      continue
    }
    if (!hostAllowed(host, allowed)) {
      rejected.push({
        fileName,
        error:
          `下载域名不在白名单：${host}。Modrinth 规范只允许 ` +
          `${MODRINTH_ALLOWED_HOSTS.join(' / ')}；确认可信后用 --allow-host ${host} 显式放行`,
      })
      continue
    }

    const meta = modrinthMeta(url)
    tasks.push({
      url,
      fileName,
      // mrpack 的 path 是相对实例根的，如 mods/xxx.jar
      destPath,
      expectedSize: file.fileSize,
      hashes: file.hashes,
      // 下载层还会再查一次域名；显式放行的域名要跟着任务带过去
      ...(opts.allowHosts === undefined ? {} : { allowHosts: opts.allowHosts }),
      ...(meta === undefined ? {} : { meta }),
    })
  }
  return { tasks, rejected }
}

/**
 * Modrinth 规范允许的下载域名。
 *
 * 只放行规范里列出的几个；`--allow-host` 用于本地服务测试与私有镜像。
 * 以 `.` 开头的条目按后缀匹配（如 `.example.com`），其余精确匹配。
 */
export const MODRINTH_ALLOWED_HOSTS: readonly string[] = [
  'cdn.modrinth.com',
  'github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'gitlab.com',
]

export interface PackTaskOptions {
  /** 额外放行的下载域名（CLI 的 --allow-host，可重复、逗号分隔） */
  readonly allowHosts?: readonly string[]
}

export interface PackTaskBuild {
  readonly tasks: readonly DownloadTask[]
  /** 清单里有、但不能下载的条目。必须并进 failed，否则「装完了」是假结论 */
  readonly rejected: readonly { readonly fileName: string; readonly error: string }[]
}

function hostAllowed(host: string, allowed: ReadonlySet<string>): boolean {
  if (allowed.has(host)) return true
  for (const rule of allowed) {
    if (rule.startsWith('.') && host.endsWith(rule)) return true
  }
  return false
}

/**
 * CurseForge 包 → 下载任务。
 *
 * 清单只说「要哪个 fileID」，URL 与哈希要先调 API 换回来（见 CurseforgeSource）。
 * 换不到的不能静默丢弃：作者关掉第三方下载、文件已下架、API 没给 sha1，
 * 三种情况都要作为失败项报出来——否则「装完了」是个假结论。
 */
export interface CurseforgeTaskResult {
  readonly tasks: readonly DownloadTask[]
  readonly unresolved: readonly { readonly fileName: string; readonly error: string }[]
}

export function buildCurseforgeTasks(
  manifest: CurseforgeManifest,
  files: ReadonlyMap<number, CfFileInfo>,
  layout: Layout,
  opts: { readonly noKey?: boolean } = {},
): CurseforgeTaskResult {
  const tasks: DownloadTask[] = []
  const unresolved: { fileName: string; error: string }[] = []
  const used = new Set<string>()

  for (const entry of manifest.files) {
    if (entry.required === false) continue
    const info = files.get(entry.fileID)
    const fallback = `project-${entry.projectID}-file-${entry.fileID}`
    if (info === undefined) {
      unresolved.push({
        fileName: fallback,
        // 没有 key 时每个文件都「查不到」。用同一句「可能已下架」会把用户
        // 引去网页逐个核对 271 个文件，而不是去配 key（issue #13）
        error:
          opts.noKey === true
            ? '没有 BLOCKPILOT_CF_API_KEY，无法换出下载地址；到 console.curseforge.com 免费申请后重试'
            : 'CurseForge 没有返回这个文件（可能已下架，或 key 没有该文件的权限）',
      })
      continue
    }
    if (info.downloadUrl === null) {
      unresolved.push({
        fileName: info.fileName,
        error: '作者关闭了第三方下载，只能从 CurseForge 网页手动下载',
      })
      continue
    }
    if (Object.keys(info.hashes).length === 0) {
      unresolved.push({ fileName: info.fileName, error: 'CurseForge 没有给 sha1，无法校验来源' })
      continue
    }
    if (!isForgeCdnUrl(info.downloadUrl)) {
      unresolved.push({
        fileName: info.fileName,
        error: `下载地址不在 Forge CDN 域：${info.downloadUrl}`,
      })
      continue
    }

    // 文件名来自接口：只取最后一段，路径分隔符不能带进实例
    const rawName = basename(info.fileName)
    if (rawName === '' || rawName === '.' || rawName === '..') {
      unresolved.push({ fileName: info.fileName, error: 'CurseForge 返回的文件名不安全' })
      continue
    }
    // CF 包的文件名理论上唯一；撞名时加 fileID 前缀，宁可难看也不要互相覆盖
    const name = used.has(rawName.toLowerCase()) ? `${entry.fileID}-${rawName}` : rawName
    const destPath = safeJoin(layout.mods, name)
    if (destPath === null) {
      unresolved.push({ fileName: info.fileName, error: '文件名会写出 mods/ 目录' })
      continue
    }
    used.add(name.toLowerCase())

    tasks.push({
      url: info.downloadUrl,
      fileName: name,
      destPath,
      expectedSize: info.size,
      hashes: info.hashes,
      meta: {
        projectId: String(info.modId),
        versionId: String(info.fileId),
        source: 'curseforge',
      },
    })
  }

  return { tasks, unresolved }
}

/**
 * 解压 overrides / client-overrides 到实例根。
 *
 * 这两个目录里放的是不在 CDN 上的文件：配置文件、资源包、脚本。
 * `client-overrides` 优先级更高，同名文件覆盖 `overrides`。
 *
 * 默认**不覆盖磁盘上已存在的文件**：ADR-0012 说「重跑是安全的」，而覆盖会
 * 把用户改过的 config/、options.txt 冲掉。要更新时显式传 `overwrite: true`
 * （CLI 的 --overwrite-overrides）。
 */
export interface OverridesOptions {
  /** true 时覆盖已存在的文件。缺省跳过并在结果里计数 */
  readonly overwrite?: boolean
}

export interface OverridesResult {
  /** 落盘的文件总数（同一个文件被 overrides 与 client-overrides 各写一次算 2） */
  readonly files: number
  /** 其中 mods/*.jar 的个数 */
  readonly mods: number
  /** 因为已存在而跳过的文件数 */
  readonly skipped: number
}

/**
 * 解压 overrides。流式读 zip、逐文件写盘，不把整个 overrides 解到内存。
 *
 * 大包（实测接近 500 MB）以前是 `readFileSync` + `unzipSync` 一次性展开，
 * 峰值内存跟着包体积线性涨。现在按条目流式解压；落盘顺序不依赖 zip 里的排列，
 * 用 `written` 记录本次写过的层级，保证 client-overrides 总是赢过 overrides。
 */
export async function extractOverrides(
  zipPath: string,
  gameDir: string,
  opts: OverridesOptions = {},
): Promise<OverridesResult> {
  let count = 0
  let mods = 0
  let skipped = 0
  let sequence = 0
  let failure: Error | undefined
  /** 本次运行写到哪个层级：client-overrides 要能覆盖同一次运行里的 overrides */
  const written = new Map<string, 'overrides' | 'client-overrides'>()
  /** 同一目标路径的落盘任务要串行：client-overrides 后写必须晚于 overrides */
  const queues = new Map<string, Promise<void>>()
  const pending: Promise<void>[] = []
  /** 文件流写缓冲满时产生的等待。每推完一个 zip 输入块就清一次 */
  const drains: Promise<void>[] = []
  const temps = new Set<string>()

  const unzip = new Unzip((file) => {
    const tier = file.name.startsWith('client-overrides/')
      ? 'client-overrides'
      : file.name.startsWith('overrides/')
        ? 'overrides'
        : null
    if (tier === null || file.name.endsWith('/')) return

    const rel = file.name.replace(/^client-overrides\//, '').replace(/^overrides\//, '')
    if (rel === '') return
    const out = safeJoin(gameDir, rel)
    if (out === null) return

    mkdirSync(dirname(out), { recursive: true })
    const tmp = `${out}.blockpilot-${process.pid}-${sequence++}.tmp`
    temps.add(tmp)
    const sink = createWriteStream(tmp)

    const finished = new Promise<void>((resolve, reject) => {
      sink.once('finish', resolve)
      sink.once('error', reject)
    })

    file.ondata = (err, chunk, final) => {
      if (err !== null) {
        failure ??= err
        sink.destroy(err)
        return
      }
      if (chunk.length > 0 && !sink.write(chunk)) {
        drains.push(
          new Promise<void>((resolve) => {
            sink.once('drain', resolve)
            sink.once('error', resolve)
            sink.once('close', resolve)
          }),
        )
      }
      if (final) sink.end()
    }

    // 同一路径必须按「上一个落盘任务完成」再决定，不能只按文件流写完，
    // 否则 client-overrides / overrides 的完成顺序会反过来
    const decide = async (): Promise<void> => {
      await finished
      const previous = written.get(out)
      // client-overrides 永远赢过 overrides；其余冲突（含同层重复）后写覆盖先写
      if (previous === 'client-overrides' && tier === 'overrides') {
        skipped += 1
        rmSync(tmp, { force: true })
        temps.delete(tmp)
        return
      }
      // 磁盘上原本就有、且本次没写过：尊重 ADR-0012 的「重跑安全」
      if (opts.overwrite !== true && previous === undefined && existsSync(out)) {
        skipped += 1
        rmSync(tmp, { force: true })
        temps.delete(tmp)
        return
      }
      renameSync(tmp, out)
      temps.delete(tmp)
      written.set(out, tier)
      count += 1
      if (rel.startsWith('mods/') && rel.toLowerCase().endsWith('.jar')) mods += 1
    }

    // 提前挂一个 catch，避免 finished 在排队期间先 reject 变成 unhandled rejection
    void finished.catch(() => {})
    const prior = queues.get(out) ?? Promise.resolve()
    const queued = prior.then(decide)
    queues.set(out, queued)
    pending.push(queued)

    file.start()
  })
  unzip.register(UnzipInflate)

  try {
    for await (const chunk of createReadStream(zipPath)) {
      unzip.push(new Uint8Array(chunk as Buffer), false)
      if (failure !== undefined) throw failure
      // 解压器不认识 Promise：写入阻塞只在这里等，避免文件流缓冲无限增长
      if (drains.length > 0) await Promise.all(drains.splice(0))
    }
    unzip.push(new Uint8Array(0), true)
    const results = await Promise.allSettled(pending)
    if (failure !== undefined) throw failure
    const rejected = results.find((r) => r.status === 'rejected')
    if (rejected !== undefined) throw rejected.reason
  } catch (err) {
    // 流可能还没关（磁盘满 / 读 zip 出错）：Windows 上删打开中的文件会 EBUSY，
    // 清理失败不能盖掉真正的错误
    for (const tmp of temps) {
      try {
        rmSync(tmp, { force: true })
      } catch {
        // 留给下一次运行；临时文件名带 pid，不会撞
      }
    }
    throw err
  }

  return { files: count, mods, skipped }
}
