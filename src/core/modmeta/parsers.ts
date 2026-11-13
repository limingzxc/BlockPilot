/**
 * 元数据文件名 → 解析器。
 *
 * `read.ts` 只按候选顺序查表，不认格式细节；新增一种格式 = 一个 parser 文件 + 这里一行。
 * Forge 的两种文件名共用同一个解析器，用 loader 提示区分身份。
 */

import { fromFabric } from './fabric.js'
import { fromForgeToml } from './forge-toml.js'
import { FABRIC, FORGE, MCMOD, NEOFORGE, QUILT } from './formats.js'
import { fromMcmodInfo } from './mcmod.js'
import { fromQuilt } from './quilt.js'
import type { ModMetadata } from './types.js'

const PARSERS: Readonly<Record<string, (text: string) => ModMetadata | null>> = {
  [FABRIC]: fromFabric,
  [QUILT]: fromQuilt,
  [NEOFORGE]: (text) => fromForgeToml(text, 'neoforge'),
  [FORGE]: (text) => fromForgeToml(text, 'forge'),
  [MCMOD]: fromMcmodInfo,
}

export function parseCandidate(name: string, text: string): ModMetadata | null {
  return PARSERS[name]?.(text) ?? null
}
