import type { FlagSpec } from './flags.js'

/** 每个子命令都接受的 `--root` / `--instance`，帮助里只解释一次。 */
export const ROOT: FlagSpec = {
  takesValue: true,
  value: '<dir>',
  common: true,
  help: '数据根目录；只需选这一次，实例目录由 --instance 派生',
}
export const INSTANCE: FlagSpec = {
  takesValue: true,
  value: '<name>',
  common: true,
  help: '实例名，缺省 default',
}
export const CHINA: FlagSpec = { takesValue: false, help: '镜像优先（mcim 提到直连之前）' }
