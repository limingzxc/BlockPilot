import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'

import type { DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import type { MrpackIndex } from '../preflight/mrpack.js'

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
