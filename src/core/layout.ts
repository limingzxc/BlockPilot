import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 根目录本身不可用（是文件、或是个打不开的路径）。CLI 直接渲染这句话。 */
export class LayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutError'
  }
}

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

/**
 * 实例名只能是单层目录名。
 *
 * 三个都是真实会撞上的：`--instance ""`（脚本里 `$NAME` 没设值）会让 gameDir 变成
 * `instances/` 本身，overrides 直接盖到别人头上；`--instance ../x` 逃出 instances；
 * 盘符路径会把名字当成另一棵树的起点。用户不会故意这么写，所以要在解析这一步
 * 说清楚，而不是让他事后发现文件长在奇怪的地方。
 */
function assertInstanceId(id: string): void {
  if (id === '') throw new LayoutError('实例名不能为空（--instance 后面要给名字）')
  if (id === '.' || id === '..') throw new LayoutError(`实例名不能是 ${id}`)
  if (/[\\/]/.test(id)) throw new LayoutError(`实例名不能包含路径分隔符：${id}`)
  if (/^[A-Za-z]:/.test(id)) throw new LayoutError(`实例名不能是盘符路径：${id}`)
  // Windows 上非法，Linux 上能用；实例目录要能跨平台拷走，统一禁掉
  if (/[\u0000-\u001f<>:"|?*]/.test(id)) throw new LayoutError(`实例名含非法字符：${id}`)
}

export function resolveLayout(root: string, instanceId = 'default'): Layout {
  assertInstanceId(instanceId)
  // 必须转绝对路径：相对路径会让 -cp 里的条目依赖进程 cwd，
  // 换个目录启动就是一堆「找不到主类」
  const base = resolve(root)

  // --root 指到文件上（常见于少打一个目录名）时，与其让 mkdir 在第三步抛 ENOTDIR，
  // 不如在解析目录布局这一步就说清楚
  if (existsSync(base)) {
    let isDir = true
    try {
      isDir = statSync(base).isDirectory()
    } catch {
      isDir = true // 权限问题交给后续步骤报，别在这里掩盖真实原因
    }
    if (!isDir) throw new LayoutError(`根目录不是文件夹：${base}`)
  }
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
