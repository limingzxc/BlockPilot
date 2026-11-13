/**
 * 消费者共用的内容源装配点。
 *
 * CLI 与 MCP 都从这里拿同一对 source：
 * - 两个入口对「--china」「--no-cf-mirror」的解释只写一次，不会一个用镜像、另一个忘了；
 * - `src/sources/` 的具体实现只在这里出现，core 仍然只认 ContentSource / CurseforgeLike 契约。
 *
 * 只做装配，不做业务：不读盘、不发请求、不决定检查流程。
 */

import type { CurseforgeLike } from './core/curseforge.js'
import { resolveCurseforge } from './sources/curseforge.js'
import { MODRINTH_API_MCIM, ModrinthSource } from './sources/modrinth.js'

export interface ContentSourceOptions {
  /** 国内镜像优先（CLI 的 --china） */
  readonly china?: boolean
  /** false = 不回落 CurseForge 镜像（CLI 的 --no-cf-mirror） */
  readonly allowCfMirror?: boolean
}

export interface ContentSources {
  readonly modrinth: ModrinthSource
  readonly curseforge: CurseforgeLike
}

export function createContentSources(opts: ContentSourceOptions = {}): ContentSources {
  return {
    modrinth: new ModrinthSource(opts.china === true ? { apiBase: MODRINTH_API_MCIM } : {}),
    curseforge: resolveCurseforge(opts.allowCfMirror === false ? { allowMirror: false } : {}),
  }
}
