/**
 * 按 lock.json 检查 / 应用模组更新。
 *
 * 默认只读：对每个带 `projectId/versionId` 的条目，向内容源反查
 * 「当前 MC 版本 + 加载器下最新兼容版本」，与 lock 里的版本比对。
 *
 * `apply: true` 才会下载新文件并替换旧文件。顺序是「先下载校验 → 再删旧文件 →
 * 最后写 lock」：任何一步失败都保留旧文件与旧 lock，不会留下「旧的删了、新的没下成」
 * 的半截实例。文件名变化时新文件落在同一目录，旧路径删除前会再检查一次是否被
 * 其他 lock 条目占用。
 */

import { existsSync, rmSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { CurseforgeLike } from '../curseforge.js'
import { downloadOne } from '../download/downloader.js'
import { runPool } from '../download/queue.js'
import { defaultSources } from '../download/sources.js'
import type { DownloadTask, Mirror } from '../download/types.js'
import { Op } from '../events.js'
import type { Operation } from '../operation.js'
import { defineOperation } from '../operation.js'
import { safeJoin } from '../safe-path.js'
import type { DependencyResolver, VersionInfo } from '../sources.js'
import type { LockedFile, LockFile } from './lock.js'
import { readLock, writeLock } from './lock.js'

export interface UpdateCheckItem {
  readonly path: string
  readonly projectId: string
  readonly name: string
  /** lock 里的版本 */
  readonly from: string
  /** 内容源给出的最新兼容版本 */
  readonly to: string
  readonly fileName: string
  readonly size: number
  readonly url: string
  readonly hashes: Readonly<Record<string, string>>
  readonly source: 'modrinth' | 'curseforge'
}

export interface UpdateApplyItem {
  readonly path: string
  readonly newPath: string
  readonly from: string
  readonly to: string
}

export interface UpdateCheckResult {
  readonly lock: LockFile
  readonly checked: number
  readonly upToDate: number
  /** 没有 projectId/versionId，或不是 Modrinth 来源 */
  readonly skipped: number
  readonly updates: readonly UpdateCheckItem[]
  readonly failed: readonly { readonly path: string; readonly error: string }[]
  /** 本次真正替换掉的文件。未传 apply 时为空 */
  readonly applied: readonly UpdateApplyItem[]
  readonly applyFailed: readonly { readonly path: string; readonly error: string }[]
}

export interface UpdateCheckOptions {
  readonly gameDir: string
  readonly resolver: DependencyResolver
  readonly concurrency?: number
  /** true 时下载并替换；缺省只检查 */
  readonly apply?: boolean
  readonly sources?: readonly Mirror[]
  /** CurseForge 反查器。没给时 CF 条目会进 failed，不影响 Modrinth 条目 */
  readonly cfResolver?: CurseforgeLike
}

function primaryFile(info: VersionInfo): VersionInfo['files'][number] | undefined {
  return info.files.find((f) => f.primary) ?? info.files[0]
}

export function checkUpdates(opts: UpdateCheckOptions): Operation<UpdateCheckResult> {
  return defineOperation<UpdateCheckResult>('update-check', async function* (signal) {
    let lock: LockFile | null
    try {
      lock = readLock(opts.gameDir)
    } catch (err) {
      if (err instanceof Error && 'code' in err) {
        yield Op.failed(String((err as { code: unknown }).code), err.message)
        return
      }
      throw err
    }
    if (lock === null) {
      yield Op.failed(
        'LOCK_NOT_FOUND',
        '这个实例没有 lock.json，无法知道每个文件来自哪个版本',
        '用 blockpilot deploy <整合包> 装一次会生成',
      )
      return
    }

    yield Op.log('info', 'update.start', { files: lock.files.length })

    const candidates: LockedFile[] = []
    let skipped = 0
    for (const file of lock.files) {
      const supported = file.source === 'modrinth' || file.source === 'curseforge'
      if (!supported || file.projectId === undefined || file.versionId === undefined) {
        skipped += 1
        continue
      }
      candidates.push(file)
    }

    const updates: UpdateCheckItem[] = []
    const failed: { path: string; error: string }[] = []
    let upToDate = 0

    await runPool(candidates, opts.concurrency ?? 4, async (file) => {
      if (signal.aborted) return
      const projectId = file.projectId
      const currentVersionId = file.versionId
      if (projectId === undefined || currentVersionId === undefined) return
      try {
        const loader = lock.target.loader.kind === 'vanilla' ? null : lock.target.loader.kind

        if (file.source === 'curseforge') {
          const cf = opts.cfResolver
          if (cf?.getLatestFile === undefined) {
            failed.push({ path: file.path, error: '未配置 CurseForge 解析器' })
            return
          }
          const latest = await cf.getLatestFile(
            Number(projectId),
            lock.target.gameVersion,
            loader,
            signal,
          )
          if (latest === null) {
            failed.push({ path: file.path, error: 'CurseForge 没有兼容当前版本的更新' })
            return
          }
          if (String(latest.fileId) === currentVersionId) {
            upToDate += 1
            return
          }
          if (latest.downloadUrl === null) {
            failed.push({ path: file.path, error: '新版本关闭了第三方下载' })
            return
          }
          updates.push({
            path: file.path,
            projectId,
            name: latest.displayName,
            from: currentVersionId,
            to: String(latest.fileId),
            fileName: latest.fileName,
            size: latest.size,
            url: latest.downloadUrl,
            hashes: latest.hashes,
            source: 'curseforge',
          })
          return
        }

        const latest = await opts.resolver.resolve(
          projectId,
          { gameVersion: lock.target.gameVersion, loader },
          signal,
        )
        if (latest === null) {
          failed.push({ path: file.path, error: '内容源没有兼容当前版本的更新' })
          return
        }
        if (latest.versionId === currentVersionId) {
          upToDate += 1
          return
        }
        const picked = primaryFile(latest)
        if (picked === undefined) {
          failed.push({ path: file.path, error: '最新版本没有可下载文件' })
          return
        }
        updates.push({
          path: file.path,
          projectId,
          name: latest.name,
          from: currentVersionId,
          to: latest.versionId,
          fileName: picked.filename,
          size: picked.size,
          url: picked.url,
          hashes: picked.hashes,
          source: 'modrinth',
        })
      } catch (err) {
        failed.push({
          path: file.path,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // runPool 的完成顺序不确定；按路径排序，输出稳定
    updates.sort((a, b) => a.path.localeCompare(b.path))
    failed.sort((a, b) => a.path.localeCompare(b.path))

    const applied: UpdateApplyItem[] = []
    const applyFailed: { path: string; error: string }[] = []

    if (opts.apply === true) {
      const sources = opts.sources ?? defaultSources()
      const nextFiles = [...lock.files]

      for (const item of updates) {
        if (signal.aborted) break
        const oldAbs = safeJoin(opts.gameDir, item.path)
        if (oldAbs === null) {
          applyFailed.push({ path: item.path, error: '旧路径不在实例目录内' })
          continue
        }
        const dest = join(dirname(oldAbs), item.fileName)
        const rel = relative(opts.gameDir, dest).split(sep).join('/')
        const conflict = nextFiles.find((f) => f.path === rel && f.path !== item.path)
        if (conflict !== undefined) {
          applyFailed.push({ path: item.path, error: `新文件名与 ${rel} 冲突` })
          continue
        }
        if (Object.keys(item.hashes).length === 0) {
          applyFailed.push({ path: item.path, error: '新版本没有哈希，拒绝下载' })
          continue
        }

        const task: DownloadTask = {
          url: item.url,
          fileName: item.fileName,
          destPath: dest,
          expectedSize: item.size,
          hashes: item.hashes,
        }

        try {
          // 先下载并校验；失败时旧文件与旧 lock 都没动
          await downloadOne(task, sources, signal)
          if (rel !== item.path && existsSync(oldAbs)) rmSync(oldAbs, { force: true })

          const sha1 = item.hashes.sha1
          const sha512 = item.hashes.sha512
          const entry: LockedFile = {
            path: rel,
            ...(sha1 === undefined ? {} : { sha1 }),
            ...(sha512 === undefined ? {} : { sha512 }),
            size: item.size,
            url: item.url,
            projectId: item.projectId,
            versionId: item.to,
            source: 'modrinth',
          }
          const index = nextFiles.findIndex((f) => f.path === item.path)
          if (index === -1) nextFiles.push(entry)
          else nextFiles[index] = entry

          applied.push({ path: item.path, newPath: rel, from: item.from, to: item.to })
          yield Op.log('info', 'update.applied', {
            path: item.path,
            from: item.from,
            to: item.to,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          applyFailed.push({ path: item.path, error: message })
          yield Op.log('warn', 'update.apply_failed', { path: item.path, error: message })
        }
      }

      if (applied.length > 0) {
        try {
          writeLock(opts.gameDir, {
            ...lock,
            files: nextFiles,
            updatedAt: new Date().toISOString(),
          })
        } catch (err) {
          applyFailed.push({
            path: 'lock.json',
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    yield Op.log('info', 'update.done', {
      checked: candidates.length,
      updates: updates.length,
      failed: failed.length,
    })

    yield Op.result({
      lock,
      checked: candidates.length,
      upToDate,
      skipped,
      updates,
      failed,
      applied,
      applyFailed,
    })
    yield Op.done()
  })
}
