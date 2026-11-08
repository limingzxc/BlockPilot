import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { probeAssetObjects } from '../setup/assets.js'
import type { AssetsProbe } from '../setup/assets.js'
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

  const probe = probeAssetObjects(
    join(indexesDir, `${indexId}.json`),
    join(assetsDir, 'objects'),
  )
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
  return [
    {
      // 一个对象都没有 = 一次都没跑过 assets，必崩；部分缺失先按 warning
      severity: nothingInstalled ? 'blocker' : 'warning',
      code: 'ASSETS_MISSING',
      message: nothingInstalled
        ? `assets 一个都没装（index ${indexId} 里有 ${probe.total} 个对象）`
        : `assets 不完整：抽查 ${probe.sampled} 个对象，缺 ${missing} 个（index ${indexId}）`,
      subject: indexId,
      hint: `1.19+ 的原版资源就在 assets 里，缺了会崩在标题画面。补：blockpilot assets ${indexId} --root <root>`,
    },
  ]
}
