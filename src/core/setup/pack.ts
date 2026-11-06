import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

import type { DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import type { MrpackIndex } from '../preflight/mrpack.js'
import type { CurseforgeManifest } from '../preflight/curseforge.js'
import type { CfFileInfo } from '../../sources/curseforge.js'

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

export function buildPackTasks(index: MrpackIndex, layout: Layout): DownloadTask[] {
  const tasks: DownloadTask[] = []
  for (const file of index.files) {
    if (!isClientRelevant(file)) continue
    const url = file.downloads[0]
    if (url === undefined) continue
    tasks.push({
      url,
      fileName: basename(file.path),
      // mrpack 的 path 是相对实例根的，如 mods/xxx.jar
      destPath: join(layout.gameDir, ...file.path.split('/')),
      expectedSize: file.fileSize,
      hashes: file.hashes,
    })
  }
  return tasks
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
        error: 'CurseForge 没有返回这个文件（可能已下架，或 key 没有该文件的权限）',
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

    // CF 包的文件名理论上唯一；撞名时加 fileID 前缀，宁可难看也不要互相覆盖
    const name = used.has(info.fileName.toLowerCase())
      ? `${entry.fileID}-${info.fileName}`
      : info.fileName
    used.add(name.toLowerCase())

    tasks.push({
      url: info.downloadUrl,
      fileName: name,
      destPath: join(layout.mods, name),
      expectedSize: info.size,
      hashes: info.hashes,
    })
  }

  return { tasks, unresolved }
}

/**
 * 解压 overrides / client-overrides 到实例根。
 *
 * 这两个目录里放的是不在 CDN 上的文件：配置文件、资源包、脚本。
 * `client-overrides` 优先级更高，同名文件覆盖 `overrides`。
 */
export function extractOverrides(zipPath: string, gameDir: string): number {
  const raw = readFileSync(zipPath)
  const entries = unzipSync(new Uint8Array(raw), {
    filter: (f) => f.name.startsWith('overrides/') || f.name.startsWith('client-overrides/'),
  })

  let count = 0
  // 先写 overrides，再写 client-overrides，后者自然覆盖前者
  const ordered = Object.entries(entries).sort(([a], [b]) => {
    const aClient = a.startsWith('client-overrides/') ? 1 : 0
    const bClient = b.startsWith('client-overrides/') ? 1 : 0
    return aClient - bClient
  })

  for (const [name, data] of ordered) {
    if (name.endsWith('/')) continue
    if (name.includes('..')) continue
    const rel = name.replace(/^client-overrides\//, '').replace(/^overrides\//, '')
    if (rel === '') continue
    const out = join(gameDir, ...rel.split('/'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    count += 1
  }
  return count
}
