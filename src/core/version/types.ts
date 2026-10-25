/** Mojang 的 version JSON 结构。只声明用得到的字段。 */

export interface Rule {
  readonly action: 'allow' | 'disallow'
  readonly os?: {
    readonly name?: 'windows' | 'osx' | 'linux'
    readonly version?: string
    readonly arch?: string
  }
  readonly features?: Readonly<Record<string, boolean>>
}

export interface VersionFileRef {
  readonly path: string
  readonly sha1: string
  readonly size: number
  readonly url: string
}

export interface Library {
  readonly name: string
  readonly downloads?: {
    readonly artifact?: VersionFileRef
    readonly classifiers?: Readonly<Record<string, VersionFileRef>>
  }
  readonly rules?: readonly Rule[]
  /** 旧版 natives 声明：{ "windows": "natives-windows" } */
  readonly natives?: Readonly<Record<string, string>>
  readonly extract?: { readonly exclude?: readonly string[] }
}

/** 1.13+ 的参数可以是裸字符串，也可以是带 rules 的对象。 */
export type ArgEntry = string | { readonly rules?: readonly Rule[]; readonly value: string | readonly string[] }

export interface VersionJson {
  readonly id: string
  readonly type: string
  readonly mainClass: string
  readonly assets: string
  readonly assetIndex?: { readonly id: string; readonly sha1: string; readonly size: number; readonly url: string }
  readonly downloads?: {
    readonly client?: VersionFileRef
    readonly server?: VersionFileRef
  }
  readonly libraries: readonly Library[]
  readonly arguments?: {
    readonly game: readonly ArgEntry[]
    readonly jvm: readonly ArgEntry[]
  }
  /** 1.12 及更早 */
  readonly minecraftArguments?: string
  readonly javaVersion?: { readonly majorVersion: number; readonly component: string }
  readonly complianceLevel?: number
}

export interface VersionManifest {
  readonly latest: { readonly release: string; readonly snapshot: string }
  readonly versions: readonly {
    readonly id: string
    readonly type: string
    readonly url: string
    readonly sha1?: string
    readonly releaseTime?: string
  }[]
}
