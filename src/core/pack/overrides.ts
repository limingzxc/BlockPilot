/**
 * 整合包 overrides 的只读统计。
 *
 * 打包者常把不允许第三方分发的模组直接塞进 overrides/mods——这些文件
 * 不需要 API key 就能校验，但以前完全不计入统计，于是「preflight 说 271 个模组」
 * 和日志里的 `Loading 304 mods` 对不上（issue #13）。
 */

import { readFileSync } from 'node:fs'
import { unzipSync } from 'fflate'

/** 只数 overrides 里的 jar，不落盘、不解压。 */
export function countOverridesMods(zipPath: string, data?: Uint8Array): number {
  let mods = 0
  try {
    unzipSync(data ?? readFileSync(zipPath), {
      filter: (f) => {
        if (f.name.endsWith('/')) return false
        if (!f.name.startsWith('overrides/') && !f.name.startsWith('client-overrides/'))
          return false
        const rel = f.name.replace(/^client-overrides\//, '').replace(/^overrides\//, '')
        if (rel.startsWith('mods/') && rel.toLowerCase().endsWith('.jar')) mods += 1
        // 一律返回 false：只要文件名，不需要解压任何内容
        return false
      },
    })
  } catch {
    return 0
  }
  return mods
}
