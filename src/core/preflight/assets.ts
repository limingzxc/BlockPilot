import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { assetsHint } from '../hints.js'
import type { AssetsProbe } from '../setup/assets.js'
import { probeAssetObjects } from '../setup/assets.js'
import type { Finding } from './types.js'

/**
 * 找一个可用的 assets 目录。
 *
 * 同一个 root 下的实例共享 assets，而实例目录本身可能是裸 .minecraft
 * 或 Prism 的 instances/<name>，所以四个位置都看一遍。
 */
export function findAssetsDir(instanceDir: string): string | null {
  const candidates = [
    join(instanceDir, 'assets'),
    join(instanceDir, '.minecraft', 'assets'),
    join(instanceDir, '..', 'assets'),
    join(instanceDir, '..', '..', 'assets'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'indexes'))) return dir
  }
  return null
}

/**
 * 从版本 id 里剥出 MC 版本。
 *
 * `run` / `setup` 拿到的是命令行原始 id，可能是加载器版本
 * （`fabric-loader-0.20.1-1.6.4`、`1.20.1-forge-47.2.0`）。直接拿去判版本会落到
 * 「匹配不上 → 按新版本处理」，于是对 1.6.4 说「会崩在标题画面」，
 * 提示里的 `blockpilot assets fabric-loader-…` 也是错的（issue #18）。
 *
 * 只看形如 `1.<minor>[.<patch>]` 的整段：`fabric-loader-0.20.1-1.6.4` 里
 * 加载器版本 `0.20.1` 不是 MC 版本，跳过它取 `1.6.4`。
 */
export function gameVersionOf(id: string): string | undefined {
  for (const seg of id.split(/[-+]/)) {
    if (/^1\.\d+(?:\.\d+)?$/.test(seg)) return seg
  }
  return undefined
}

/**
 * 缺 assets 会不会**开不了游戏**。
 *
 * 1.19+ 的原版资源包就是 assets 本身，零资源时标题画面渲染直接抛
 * NoSuchFileException；1.12 及更早只是没声音、字是方框，能进游戏。
 * 把两者混为一谈会给老版本塞一条假的 blocker（issue #10 实测 1.6.4）。
 */
export function assetsRequiredToBoot(gameVersion: string): boolean {
  if (gameVersion === 'unknown' || gameVersion === '') return false
  // 命令行给的可能是加载器版本 id，先剥出真正的 MC 版本
  const mc = gameVersionOf(gameVersion) ?? gameVersion
  const m = /^1\.(\d+)/.exec(mc)
  // 26.x 这类新命名没有「1.」前缀，一律按新版本处理
  if (m === null) return true
  return Number(m[1]) >= 19
}

export interface AssetsProbeResult {
  readonly indexId: string
  readonly probe: AssetsProbe
}

/**
 * 抽查指定版本的 assets。
 *
 * index 文件名不一定等于 MC 版本号（1.6.4 用的是 `legacy.json`），
 * 所以找不到同名 index 时退回到目录里任意一份——同一 root 的实例共享同一批对象，
 * 抽查哪一份都能区分「装过」和「没装」。
 */
export function probeAssets(assetsDir: string, gameVersion?: string): AssetsProbeResult | null {
  const indexesDir = join(assetsDir, 'indexes')
  if (!existsSync(indexesDir)) return null

  let indexId: string | undefined
  if (gameVersion !== undefined && existsSync(join(indexesDir, `${gameVersion}.json`))) {
    indexId = gameVersion
  } else {
    const pick = readdirSync(indexesDir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .pop()
    indexId = pick === undefined ? undefined : pick.slice(0, -'.json'.length)
  }
  if (indexId === undefined) return null

  const probe = probeAssetObjects(join(indexesDir, `${indexId}.json`), join(assetsDir, 'objects'))
  return probe === null ? null : { indexId, probe }
}

/**
 * preflight 的 assets 检查（issue #2）。
 *
 * 以前 launch 前的闸门只验 `assets/indexes/<id>.json` 在不在——json 是 setup
 * 下的，objects 要单独跑 `blockpilot assets`，于是零资源的实例一路通过检查，
 * 然后崩在标题画面。
 */
export function checkAssets(
  instanceDir: string,
  gameVersion: string,
  assetsDirOverride?: string,
): readonly Finding[] {
  const assetsDir = assetsDirOverride ?? findAssetsDir(instanceDir)
  if (assetsDir === null) return []

  const found = probeAssets(assetsDir, gameVersion)
  if (found === null || found.probe.total === 0) return []
  const { indexId, probe } = found
  if (probe.present === probe.sampled) return []

  const missing = probe.sampled - probe.present
  const nothingInstalled = probe.present === 0
  // 提示里必须给 **MC 版本**，不是 index id：1.20.1 的 index 叫 `5`，
  // 而 `blockpilot assets 5` 会去取 5.json 版本清单，直接 404。
  const cmdVersion = gameVersion === '' || gameVersion === 'unknown' ? 'MC 版本' : gameVersion
  const fatal = assetsRequiredToBoot(gameVersion)
  return [
    {
      // 一个对象都没有 + 1.19+ = 必崩；老版本只是没声音，永远不进 blocker
      severity: fatal && nothingInstalled ? 'blocker' : 'warning',
      code: 'ASSETS_MISSING',
      message: nothingInstalled
        ? `assets 一个都没装（index ${indexId} 里有 ${probe.total} 个对象）`
        : `assets 不完整：抽查 ${probe.sampled} 个对象，缺 ${missing} 个（index ${indexId}）`,
      subject: indexId,
      hint: fatal
        ? `1.19+ 的原版资源就在 assets 里，缺了会崩在标题画面。补：${assetsHint(cmdVersion)}`
        : `这个版本缺 assets 只影响声音与语言，不影响启动。想补：${assetsHint(cmdVersion)}`,
    },
  ]
}
