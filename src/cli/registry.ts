/**
 * 全部子命令的注册表。
 *
 * 全仓只有这里知道所有命令：入口只做分发，测试从这里取命令集合，
 * 命令实现之间互不 import。
 */

import type { Command } from './command/define.js'
import { cmdAccounts } from './commands/accounts.js'
import { cmdAssets } from './commands/assets.js'
import { cmdConfig } from './commands/config.js'
import { cmdDeploy } from './commands/deploy.js'
import { cmdDiag } from './commands/diag.js'
import { cmdFabric } from './commands/fabric.js'
import { cmdForge, cmdNeoforge } from './commands/forge.js'
import { cmdInstall } from './commands/install.js'
import { cmdJava } from './commands/java.js'
import { cmdLaunch } from './commands/launch.js'
import { cmdLogin } from './commands/login.js'
import { cmdLogs } from './commands/logs.js'
import { cmdPreflight } from './commands/preflight.js'
import { cmdQuilt } from './commands/quilt.js'
import { cmdRun } from './commands/run.js'
import { cmdSetup } from './commands/setup.js'
import { cmdUpdate } from './commands/update.js'
import { cmdVerify } from './commands/verify.js'

/** 全部子命令。声明在 handlers 之后，`run` 引用的是提升的函数声明。 */
export const COMMANDS: readonly Command[] = [
  cmdPreflight,
  cmdInstall,
  cmdJava,
  cmdLogin,
  cmdAccounts,
  cmdSetup,
  cmdAssets,
  cmdFabric,
  cmdQuilt,
  cmdForge,
  cmdNeoforge,
  cmdDeploy,
  cmdVerify,
  cmdUpdate,
  cmdConfig,
  cmdLaunch,
  cmdRun,
  cmdLogs,
  cmdDiag,
]
