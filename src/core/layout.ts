import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 磁盘布局。参照 Prism/MultiMC 的模型：
 *
 *   <root>/                       用户选一次
 *     libraries/                  所有实例共享（几百 MB）
 *     assets/                     所有实例共享（1–2 GB）
 *     versions/<id>/<id>.jar      原版 client jar
 *     instances/<instanceId>/     每个实例独立
 *       natives/<versionId>/      解压出来的原生库
 *       mods/
 *       options.txt 等
 *
 * 为什么不让每个实例复制一份完整目录：assets 动辄 1–2 GB，
 * 十来个实例就是十几 GB 的重复。共享的是只读资源，隔离的是会被改的东西。
 */
export interface Layout {
  readonly root: string
  readonly instanceId: string
  /** 实例的游戏目录，等价于 .minecraft */
  readonly gameDir: string
  readonly libraries: string
  readonly assets: string
  readonly versions: string
  readonly mods: string
  nativesDir(versionId: string): string
  clientJar(versionId: string): string
  assetIndex(indexId: string): string
  /** 本地版本 JSON。加载器装完后写在这里，启动时优先读它 */
  versionJson(versionId: string): string
}

export function resolveLayout(root: string, instanceId = 'default'): Layout {
  // 必须转绝对路径：相对路径会让 -cp 里的条目依赖进程 cwd，
  // 换个目录启动就是一堆「找不到主类」
  const base = resolve(root)
  return {
    root: base,
    instanceId,
    gameDir: join(base, 'instances', instanceId),
    libraries: join(base, 'libraries'),
    assets: join(base, 'assets'),
    versions: join(base, 'versions'),
    mods: join(base, 'instances', instanceId, 'mods'),
    nativesDir: (versionId) => join(base, 'instances', instanceId, 'natives', versionId),
    clientJar: (versionId) => join(base, 'versions', versionId, `${versionId}.jar`),
    assetIndex: (indexId) => join(base, 'assets', 'indexes', `${indexId}.json`),
    versionJson: (versionId) => join(base, 'versions', versionId, `${versionId}.json`),
  }
}

/**
 * 默认根目录。给用户一个不用想的默认值，同时允许 --root 覆盖。
 *
 * 不用「程序所在目录」：安装到 Program Files 时那里通常不可写，
 * 而且用户换个版本的程序就会丢掉整个游戏库。
 */
export function defaultRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const appData = process.env['APPDATA']
    if (appData !== undefined && appData !== '') return join(appData, 'BlockPilot')
    return join(homedir(), 'AppData', 'Roaming', 'BlockPilot')
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BlockPilot')
  }
  const xdg = process.env['XDG_DATA_HOME']
  if (xdg !== undefined && xdg !== '') return join(xdg, 'blockpilot')
  return join(homedir(), '.local', 'share', 'blockpilot')
}
