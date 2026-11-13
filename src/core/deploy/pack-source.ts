/**
 * deploy 的整合包来源解析：本地路径，或 Modrinth project slug。
 *
 * 这里承担「slug → 下载 → cache/packs」的全部业务：判断输入形态、挑 mrpack 文件、
 * 清洗文件名、落到 cache。CLI 只负责把结果渲染出来，不再自己拼路径或下载。
 *
 * 远程反查只依赖一个最小接口（LatestVersionSource），core 不会绑到 Modrinth 实现上。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { VersionInfo } from '../content-source.js'
import { downloadOne } from '../download/downloader.js'
import type { Mirror } from '../download/types.js'
import { BlockPilotError, errMessage } from '../errors.js'
import type { Layout } from '../layout.js'
import { safeJoin } from '../safe-path.js'

/** Modrinth 反查只需要这一个能力；具体实现由消费者注入。 */
export interface LatestVersionSource {
  getLatestVersion(slug: string, signal: AbortSignal): Promise<VersionInfo | null>
}

export interface ResolvePackTargetOptions {
  readonly target: string
  readonly layout: Layout
  readonly source: LatestVersionSource
  readonly mirrors: readonly Mirror[]
  readonly signal: AbortSignal
  /** 测试注入：把下载换成不联网的替身 */
  readonly download?: typeof downloadOne
}

export interface PackTarget {
  readonly path: string
  /** 从 Modrinth 下载时带上的展示信息；本地包为 undefined */
  readonly remote?: {
    readonly name: string
    readonly versionId: string
    readonly fileName: string
  }
}

/** Modrinth project slug：字母数字开头，可含 - 与 _。 */
const SLUG = /^[0-9A-Za-z][0-9A-Za-z_-]{1,63}$/

function looksLikeSlug(target: string): boolean {
  return (
    !target.includes('/') &&
    !target.includes('\\') &&
    !/\.(mrpack|zip)$/i.test(target) &&
    SLUG.test(target)
  )
}

/**
 * 解析 deploy 的 target。
 *
 * - 路径存在 → 原样返回；
 * - 像路径 / 带包后缀 / 不是 slug → 原样返回，让 `createDeploy` 报 `BAD_MODPACK`；
 * - 像 slug → 去 Modrinth 取最新 release 的 mrpack，落到 `<root>/cache/packs/`。
 */
export async function resolvePackTarget(opts: ResolvePackTargetOptions): Promise<PackTarget> {
  const target = opts.target.trim()
  if (existsSync(target)) return { path: target }
  if (!looksLikeSlug(target)) return { path: target }

  let info: VersionInfo | null
  try {
    info = await opts.source.getLatestVersion(target, opts.signal)
  } catch (err) {
    throw new BlockPilotError('PACK_QUERY_FAILED', `查询 Modrinth 失败: ${errMessage(err)}`, {
      cause: err,
    })
  }
  if (info === null) {
    throw new BlockPilotError('PACK_NOT_FOUND', `Modrinth 上找不到 ${target}`, {
      hint: '确认 slug；或直接传本地 .mrpack / .zip 路径',
    })
  }

  const file =
    info.files.find((f) => f.primary && f.filename.toLowerCase().endsWith('.mrpack')) ??
    info.files.find((f) => f.filename.toLowerCase().endsWith('.mrpack')) ??
    info.files[0]
  if (file === undefined) {
    throw new BlockPilotError('PACK_NO_FILE', `${info.name} 的最新版本没有可下载文件`)
  }

  // 文件名来自 API；只取 basename，并确认落点仍在 cache/packs 下
  const fileName = basename(file.filename)
  const dest = safeJoin(join(opts.layout.root, 'cache', 'packs'), fileName)
  if (dest === null) {
    throw new BlockPilotError('PACK_UNSAFE_NAME', `Modrinth 返回的文件名不安全: ${file.filename}`)
  }

  const download = opts.download ?? downloadOne
  try {
    await download(
      {
        url: file.url,
        fileName,
        destPath: dest,
        expectedSize: file.size,
        hashes: file.hashes,
      },
      opts.mirrors,
      opts.signal,
    )
  } catch (err) {
    throw new BlockPilotError('PACK_DOWNLOAD_FAILED', `下载整合包失败: ${errMessage(err)}`, {
      cause: err,
    })
  }

  return {
    path: dest,
    remote: { name: info.name, versionId: info.versionId, fileName },
  }
}
