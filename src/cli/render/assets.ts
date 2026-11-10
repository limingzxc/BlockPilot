import { assetsHint } from '../../core/hints.js'
import { assetsRequiredToBoot, gameVersionOf } from '../../core/preflight/assets.js'
import type { AssetsProbe } from '../../core/setup/assets.js'
import { C } from '../ui.js'

/**
 * assets 没装全的提示。
 *
 * 1.19+ 的原版资源包就是 assets 本身，零资源时标题画面渲染直接抛
 * NoSuchFileException——所以这不是「没声音」级别的小毛病，而是必崩。
 */
export function assetsIncompleteHint(
  assets: AssetsProbe | null,
  versionId: string,
): string | undefined {
  if (assets === null || assets.sampled === 0) return undefined
  if (assets.present === assets.sampled) return undefined
  const missing = assets.sampled - assets.present
  const head = `assets 没装全（抽查 ${assets.sampled} 个对象，缺 ${missing} 个）`
  // 命令行给的可能是加载器版本 id（fabric-loader-0.20.1-1.6.4）：
  // 判版本和给命令都要用剥出来的 MC 版本，否则 1.6.4 会被说成「会崩在标题画面」
  const mc = gameVersionOf(versionId) ?? versionId
  // 1.19+ 缺了会崩在标题画面；更早的版本只是没声音——同一句话会把老玩家吓一跳
  const tail = assetsRequiredToBoot(mc)
    ? '· 1.19+ 会崩在标题画面'
    : '· 这个版本只影响声音与语言，能进游戏'
  return `${head}${tail}\n    ${C.dim}补：${assetsHint(mc)}${C.reset}`
}
