/**
 * 整合包 → 下载任务。
 *
 * 两种格式的差异只在这里：mrpack 自带 URL 与哈希；CurseForge 需要先用
 * fileID 换 URL。编排层只拿到统一的 tasks + unresolved。
 */
import type { CfFileInfo } from '../curseforge.js'
import type { DownloadTask } from '../download/types.js'
import type { Layout } from '../layout.js'
import type { PackFileRead } from '../pack/index.js'
import { buildCurseforgeTasks, buildPackTasks } from '../setup/pack.js'

export interface SourceTasksInput {
  readonly pack: PackFileRead
  readonly cfFiles: ReadonlyMap<number, CfFileInfo>
  readonly cfNoKey: boolean
  readonly layout: Layout
  readonly allowHosts?: readonly string[]
}

export interface SourceTasksResult {
  readonly tasks: readonly DownloadTask[]
  /** 清单里有、但不能下载的条目。必须并进失败列表，否则「装完了」是假结论 */
  readonly unresolved: readonly { readonly fileName: string; readonly error: string }[]
}

export function buildSourceTasks(input: SourceTasksInput): SourceTasksResult {
  if (input.pack.kind === 'mrpack') {
    const mr = buildPackTasks(
      input.pack.mrpackIndex,
      input.layout,
      input.allowHosts === undefined ? {} : { allowHosts: input.allowHosts },
    )
    return { tasks: mr.tasks, unresolved: mr.rejected }
  }
  const cf = buildCurseforgeTasks(input.pack.curseforgeManifest, input.cfFiles, input.layout, {
    noKey: input.cfNoKey,
  })
  return { tasks: cf.tasks, unresolved: cf.unresolved }
}
