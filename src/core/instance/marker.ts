import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LoaderKind } from '../instance.js'

/**
 * 实例版本标记。
 *
 * 用 Prism/MultiMC 的 `mmc-pack.json` 格式，而不是自造一个 `blockpilot.json`：
 * 一来 `scanInstanceDir` 本来就认这个文件，二来用户把实例拖进 Prism 也能直接用。
 * 自造格式只会让「谁认识这份元数据」这个问题多一个答案。
 */
export const MARKER_FILE = 'mmc-pack.json'

const LOADER_UID: Readonly<Record<Exclude<LoaderKind, 'vanilla'>, string>> = {
  fabric: 'net.fabricmc.fabric-loader',
  quilt: 'org.quiltmc.quilt-loader',
  forge: 'net.minecraftforge',
  neoforge: 'net.neoforged',
}

interface MmcComponent {
  readonly uid?: string
  readonly version?: string
  [key: string]: unknown
}

interface MmcPackFile {
  readonly components?: readonly MmcComponent[]
  [key: string]: unknown
}

export interface InstanceMarker {
  readonly gameVersion: string
  /** 不传就只写 MC 版本（原版），已有的加载器组件保持不动 */
  readonly loader?: { readonly kind: LoaderKind; readonly version: string }
}

/**
 * 写 `<实例>/mmc-pack.json`，与已有内容合并。
 *
 * 合并而不是覆盖：先 `setup` 再 `fabric` 是两个命令，第二次不该把第一次写的
 * MC 版本抹掉；反过来，`setup` 重跑也不该把已经装好的加载器信息抹掉。
 */
export function writeInstanceMarker(gameDir: string, marker: InstanceMarker): string {
  const path = join(gameDir, MARKER_FILE)
  const existing = readMarkerFile(path)
  const components: MmcComponent[] = [...(existing.components ?? [])]

  const upsert = (uid: string, version: string): void => {
    const i = components.findIndex((c) => c.uid === uid)
    if (i === -1) components.push({ uid, version })
    else components[i] = { ...components[i], uid, version }
  }

  upsert('net.minecraft', marker.gameVersion)
  if (marker.loader !== undefined && marker.loader.kind !== 'vanilla') {
    const keep = LOADER_UID[marker.loader.kind]
    /**
     * 换加载器时旧组件必须移除。
     *
     * `scanInstanceDir` 用 `find` 取第一个命中的加载器组件；残留的 Fabric
     * 组件会让 Forge 实例继续被判成 Fabric，新包的模组全被判成
     * LOADER_MISMATCH 而跳过检查。
     */
    for (let i = components.length - 1; i >= 0; i -= 1) {
      const uid = components[i]?.uid
      if (uid !== undefined && uid !== keep && Object.values(LOADER_UID).includes(uid)) {
        components.splice(i, 1)
      }
    }
    upsert(keep, marker.loader.version)
  }

  const next: MmcPackFile = { ...existing, formatVersion: 1, components }
  mkdirSync(gameDir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return path
}

function readMarkerFile(path: string): MmcPackFile {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as MmcPackFile
  } catch {
    // 坏文件当作不存在：标记只是加速与校验用的，读不出来不该让安装失败
    return {}
  }
}
