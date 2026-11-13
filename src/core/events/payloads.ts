/**
 * 全部事件载荷的汇总点。
 *
 * 每个业务域只在自己的文件里声明载荷；这里只做接口合并，
 * 这样新增事件码不改别人的域文件，也不会漏登记。
 */
import type { AssetsPayloads } from './assets.js'
import type { AuthPayloads } from './auth.js'
import type { CurseforgePayloads } from './curseforge.js'
import type { DeployPayloads } from './deploy.js'
import type { DepsPayloads } from './deps.js'
import type { DiagPayloads } from './diag.js'
import type { DownloadPayloads } from './download.js'
import type { FabricPayloads } from './fabric.js'
import type { ForgePayloads } from './forge.js'
import type { InstallPayloads } from './install.js'
import type { InstancePayloads } from './instance.js'
import type { JavaPayloads } from './java.js'
import type { LaunchPayloads } from './launch.js'
import type { QuiltPayloads } from './quilt.js'
import type { SetupPayloads } from './setup.js'
import type { UpdatePayloads } from './update.js'
import type { VerifyPayloads } from './verify.js'

export interface LogPayloads
  extends AuthPayloads,
    AssetsPayloads,
    CurseforgePayloads,
    DeployPayloads,
    DepsPayloads,
    DiagPayloads,
    DownloadPayloads,
    FabricPayloads,
    QuiltPayloads,
    ForgePayloads,
    InstallPayloads,
    InstancePayloads,
    JavaPayloads,
    LaunchPayloads,
    SetupPayloads,
    VerifyPayloads,
    UpdatePayloads {}
