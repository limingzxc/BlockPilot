import { existsSync, readFileSync } from 'node:fs'

import type { Layout } from '../layout.js'
import { fetchVersionJson } from './fetch.js'
import { mergeVersionJson } from './inherit.js'
import type { VersionJson } from './types.js'

export interface ResolveOptions {
  readonly layout: Layout
  readonly mirror?: boolean
  readonly signal?: AbortSignal
}

export interface ResolvedVersion {
  readonly json: VersionJson
  /**
   * 最底层的原版版本 id。
   *
   * 加载器版本**没有自己的 client jar**——Fabric 的 profile 里也没有 `jar` 字段。
   * classpath 要用父版本（1.20.1）的那个 jar，所以必须把根 id 一起带出来。
   */
  readonly rootId: string
}

/**
 * 取出版本 JSON，如果是加载器版本就沿着 inheritsFrom 一路合并上去。
 *
 * 顺序很重要：**先看本地**。加载器的 profile 是本地文件（`versions/<id>/<id>.json`），
 * Mojang 的 manifest 里根本没有它。先远程会直接 404。
 */
export async function resolveVersion(
  versionId: string,
  opts: ResolveOptions,
  seen: Set<string> = new Set(),
): Promise<ResolvedVersion> {
  if (seen.has(versionId)) {
    throw new Error(`版本继承出现循环：${[...seen, versionId].join(' -> ')}`)
  }
  seen.add(versionId)

  const localPath = opts.layout.versionJson(versionId)
  const json = existsSync(localPath)
    ? (JSON.parse(readFileSync(localPath, 'utf8')) as VersionJson)
    : await fetchVersionJson(versionId, {
        ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      })

  if (json.inheritsFrom === undefined) {
    return { json, rootId: versionId }
  }

  const parent = await resolveVersion(json.inheritsFrom, opts, seen)
  return {
    json: mergeVersionJson(parent.json, json),
    rootId: parent.rootId,
  }
}
