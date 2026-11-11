/**
 * Instance identity：`<实例>/mmc-pack.json` 的唯一读写入口。
 *
 * 这是 Prism/MultiMC 的格式，不是自造文件——`scanInstanceDir` 本来就认它，
 * 用户把实例拖进 Prism 也能直接用（ADR-0008）。
 *
 * 此前写入（`marker.ts`）与读取（`scan.ts`）各持一份 Loader↔uid 表与一套解析：
 * 新增一种 Loader 要改两处，漏一处就会让「装完是 Forge，扫描说是 Fabric」。
 * 身份只有一个 authority：格式、uid 表、合并规则都在这。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { LoaderKind, LoaderRef } from '../instance.js'

export const MARKER_FILE = 'mmc-pack.json'

const LOADER_UID: Readonly<Record<Exclude<LoaderKind, 'vanilla'>, string>> = {
  fabric: 'net.fabricmc.fabric-loader',
  quilt: 'org.quiltmc.quilt-loader',
  forge: 'net.minecraftforge',
  neoforge: 'net.neoforged',
}

/** uid → Loader。表只有一个方向，反查也走它，避免两份映射各写各的。 */
function loaderOfUid(uid: string): Exclude<LoaderKind, 'vanilla'> | undefined {
  for (const [kind, value] of Object.entries(LOADER_UID)) {
    if (value === uid) return kind as Exclude<LoaderKind, 'vanilla'>
  }
  return undefined
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

/** 从磁盘读到的身份。两个字段都可能缺失：目录可能根本没有标记文件。 */
export interface InstanceIdentity {
  readonly gameVersion?: string
  readonly loader?: LoaderRef
}

export interface InstanceIdentityInput {
  readonly gameVersion: string
  /** 不传就只写 MC 版本（原版），已有的加载器组件保持不动 */
  readonly loader?: LoaderRef
}

/**
 * 读 `mmc-pack.json`。文件不存在或坏掉都返回空身份：
 * 标记只是加速与校验用的，读不出来不该让安装/预检失败。
 */
export function readInstanceIdentity(gameDir: string): InstanceIdentity {
  const path = join(gameDir, MARKER_FILE)
  if (!existsSync(path)) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const components = (parsed as MmcPackFile).components ?? []
  const mc = components.find((c) => c.uid === 'net.minecraft')
  const loaderComp = components.find((c) => c.uid !== undefined && loaderOfUid(c.uid) !== undefined)
  const kind = loaderComp?.uid === undefined ? undefined : loaderOfUid(loaderComp.uid)

  return {
    ...(mc?.version === undefined ? {} : { gameVersion: mc.version }),
    ...(kind === undefined ? {} : { loader: { kind, version: loaderComp?.version ?? 'unknown' } }),
  }
}

/**
 * 写 `mmc-pack.json`，与已有内容合并。
 *
 * 合并而不是覆盖：先 `setup` 再 `fabric` 是两个命令，第二次不该把第一次写的
 * MC 版本抹掉；反过来，`setup` 重跑也不该把已经装好的加载器信息抹掉。
 */
export function writeInstanceIdentity(gameDir: string, identity: InstanceIdentityInput): string {
  const path = join(gameDir, MARKER_FILE)
  const existing = readPackFile(path)
  const components: MmcComponent[] = [...(existing.components ?? [])]

  const upsert = (uid: string, version: string): void => {
    const i = components.findIndex((c) => c.uid === uid)
    if (i === -1) components.push({ uid, version })
    else components[i] = { ...components[i], uid, version }
  }

  upsert('net.minecraft', identity.gameVersion)
  if (identity.loader !== undefined && identity.loader.kind !== 'vanilla') {
    const keep = LOADER_UID[identity.loader.kind]
    /**
     * 换加载器时旧组件必须移除。
     *
     * `scanInstanceDir` 取第一个命中的加载器组件；残留的 Fabric 组件会让
     * Forge 实例继续被判成 Fabric，新包的模组全被判成 LOADER_MISMATCH 而跳过检查。
     */
    for (let i = components.length - 1; i >= 0; i -= 1) {
      const uid = components[i]?.uid
      if (uid !== undefined && uid !== keep && Object.values(LOADER_UID).includes(uid)) {
        components.splice(i, 1)
      }
    }
    upsert(keep, identity.loader.version)
  }

  const next: MmcPackFile = { ...existing, formatVersion: 1, components }
  mkdirSync(gameDir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return path
}

/** 写之前读原始文件：合并要保留 Prism 自己写的顶层字段。 */
function readPackFile(path: string): MmcPackFile {
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
