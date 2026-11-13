/**
 * 启动环境描述：OS / 架构 / features。
 *
 * launch 用它展开版本 JSON 的 rules，事件载荷 `launch.env` 也直接携带这个形状。
 * 放在 core 根而不是 `launch/`，事件模块引用它时不必反向依赖 launch。
 */

export type OsName = 'windows' | 'osx' | 'linux'
export type OsArch = 'x86' | 'x86_64' | 'arm64'

export interface LaunchEnv {
  readonly os: OsName
  readonly arch: OsArch
  /** Windows 的版本号，如 "10.0"；rules 里可能用正则约束 */
  readonly osVersion?: string
  /** 给 rules.features 用的开关，默认全 false */
  readonly features: Readonly<Record<string, boolean>>
}
