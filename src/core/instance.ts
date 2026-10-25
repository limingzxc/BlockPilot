/** 领域模型。术语见 GLOSSARY.md，不要在这里发明新名字。 */

export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt'

export interface LoaderRef {
  readonly kind: LoaderKind
  readonly version: string
}

export type Side = 'required' | 'optional' | 'unsupported'

export interface ModRef {
  /** 在线源侧的稳定标识（Modrinth base62 id / CurseForge 数字 id）。本地 jar 没有。 */
  readonly projectId?: string
  readonly versionId?: string
  /** jar 内声明的 modId。本地模组只有这个，它和 projectId 是两套身份。 */
  readonly modId?: string
  readonly source: 'modrinth' | 'curseforge' | 'local'
  /** 实例目录内的相对路径，如 mods/create-0.5.1.jar */
  readonly fileName: string
  readonly client?: Side
  readonly server?: Side
}

export interface Instance {
  readonly id: string
  readonly name: string
  readonly gameVersion: string
  readonly loader: LoaderRef
  readonly mods: readonly ModRef[]
}

/** 本机环境。预检需要它才能判断 Java / 内存是否够。 */
export interface HostProfile {
  readonly os: 'windows' | 'linux' | 'macos' | 'unknown'
  readonly totalMemoryMiB: number
  readonly javaMajors: readonly number[]
}
