import type { DownloadSource } from './types.js'

/** 直连官方。对任何 URL 都返回原地址，永远排最后作为兜底。 */
export const directSource: DownloadSource = {
  name: 'direct',
  credit: '直连官方源',
  rewrite: (url) => url.toString(),
}

/**
 * BMCLAPI —— 「前缀替换，路径与官方 100% 兼容」。
 *
 * 覆盖 Mojang 的版本清单、资源、库，以及 Forge/Fabric 的 maven。
 * **NeoForge 的 maven 有路由但缓存为空**（/maven/net/neoforged/... 302 后无内容，
 * 2026-10-25 实测）——所以 NeoForge 要靠下面的 forgecdn 源。
 * **不覆盖 Modrinth / CurseForge 的 CDN。**
 *
 * 协议要求（bmclapidoc.bangbang93.com）：所有使用 BMCLAPI 的程序
 * **必须在下载界面或其他可视部分标明来源**，且禁止在其上二次封装其他协议。
 * 所以这个源的 credit 不能被省略——它是合规的一部分，不是装饰。
 */
const BMCLAPI_HOST = 'bmclapi2.bangbang93.com'

const BMCLAPI_MAP: ReadonlyArray<readonly [string, string]> = [
  ['piston-meta.mojang.com', ''],
  ['launchermeta.mojang.com', ''],
  ['launcher.mojang.com', ''],
  ['resources.download.minecraft.net', '/assets'],
  ['libraries.minecraft.net', '/maven'],
  ['files.minecraftforge.net', '/maven'],
  ['maven.minecraftforge.net', '/maven'],
  ['meta.fabricmc.net', '/fabric-meta'],
]

export const bmclapiSource: DownloadSource = {
  name: 'bmclapi',
  credit: 'BMCLAPI · bmclapi2.bangbang93.com',
  rewrite: (url) => {
    const entry = BMCLAPI_MAP.find(([host]) => host === url.hostname)
    if (entry === undefined) return null
    return `https://${BMCLAPI_HOST}${entry[1]}${url.pathname}${url.search}`
  },
}

/**
 * MCIM —— Modrinth / CurseForge 的镜像。
 *
 * 官方规则（mcim-api README）：
 *   cdn.modrinth.com                      -> mod.mcimirror.top       （路径不变）
 *   edge.forgecdn.net / mediafilez.*      -> mod.mcimirror.top       （路径不变）
 *   api.modrinth.com                      -> mod.mcimirror.top/modrinth
 *   api.curseforge.com                    -> mod.mcimirror.top/curseforge
 *
 * 三点必须注意：
 * 1. **它未必加速文件。** 2026-10-25 实测 /data/... 返回 302 跳回官方 CDN。
 * 2. **服务不可用时会返回 HTTP 200 + 2231 字节的 HTML 错误页**，
 *    状态码完全不可信，只能靠大小与哈希挡。
 * 3. 官方要求**先登记启动器 UA**（mcim-rust-api issue #12），可能启用白名单。
 *
 * 所以默认排在 direct 之后：直连失败才用它。
 */
export const mcimSource: DownloadSource = {
  name: 'mcim',
  credit: 'MCIM · mod.mcimirror.top',
  rewrite: (url) => {
    const mirrorable = new Set([
      'cdn.modrinth.com',
      'edge.forgecdn.net',
      'mediafilez.forgecdn.net',
    ])
    if (!mirrorable.has(url.hostname)) return null
    return `https://mod.mcimirror.top${url.pathname}${url.search}`
  },
}

/**
 * NeoForge 官方 maven 的镜像。
 *
 * `maven.neoforged.net` 在国内被墙，BMCLAPI 的路由是空壳（见上）。
 * `neoforged.forgecdn.net` 是 NeoForged 社区在用的镜像，与官方 maven
 * **路径完全兼容**（/releases/... 不变，只换域名），2026-10-25 实测：
 * maven-metadata.xml、installer.jar、.sha1 全部 200，sha1 与官方一致，
 * 直连速度约 180 KB/s。出处是 MC百科 论坛的应对帖（2025-08 仓库被墙时）。
 *
 * 它只覆盖这一个域，对其他 URL 返回 null——放进默认列表没有副作用。
 */
export const neoforgeCdnSource: DownloadSource = createMirrorSource({
  name: 'neoforge-cdn',
  from: 'maven.neoforged.net',
  to: 'https://neoforged.forgecdn.net',
  credit: 'NeoForge CDN · neoforged.forgecdn.net',
})

export interface MirrorConfig {
  readonly name: string
  /** 要替换的原始 host，如 maven.minecraftforge.net */
  readonly from: string
  /** 替换后的 base，不含尾部斜杠。路径原样拼接。 */
  readonly to: string
  /** 可选的路径前缀映射，用于 BMCLAPI 那种 host->prefix 的情况 */
  readonly pathPrefix?: string
  /** 展示给用户的署名。第三方镜像的协议可能同样要求标注。 */
  readonly credit: string
}

/**
 * 用配置拼一个镜像源。
 *
 * 存在的理由：镜像站地址会变，有的站点两年内换过三次域名。任何写死在源码里的
 * 镜像 URL 都注定过期，所以在配置里填比改源码现实。
 *
 * 内置源刻意只保留 BMCLAPI / direct / MCIM 三个——每多一个默认源就多一个
 * 可能超时的失败点，而绝大多数镜像对本项目的增量价值接近于零。
 */
export function createMirrorSource(cfg: MirrorConfig): DownloadSource {
  const base = cfg.to.replace(/\/+$/, '')
  const prefix = cfg.pathPrefix ?? ''
  return {
    name: cfg.name,
    credit: cfg.credit,
    rewrite: (url) =>
      url.hostname === cfg.from ? `${base}${prefix}${url.pathname}${url.search}` : null,
  }
}

/**
 * 默认源列表：BMCLAPI 管 Mojang 域，forgecdn 管 NeoForge 域，
 * MCIM 排在直连之后（理由见 mcimSource 注释——官方自己都说「下载失败后再用镜像」）。
 */
export function defaultSources(): readonly DownloadSource[] {
  return [bmclapiSource, neoforgeCdnSource, directSource, mcimSource]
}

/** 国内网络优先：镜像先上，直连兜底。 */
export function chinaFirstSources(): readonly DownloadSource[] {
  return [bmclapiSource, neoforgeCdnSource, mcimSource, directSource]
}
