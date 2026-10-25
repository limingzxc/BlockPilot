import { join } from 'node:path'

import type { ArgEntry, Library, VersionJson } from '../version/types.js'
import type { LaunchEnv } from './env.js'
import { rulesAllow } from './env.js'

const SUBST = /\$\{([a-zA-Z0-9_]+)\}/g

export function substitute(input: string, vars: Readonly<Record<string, string>>): string {
  return input.replace(SUBST, (whole, key: string) => vars[key] ?? whole)
}

/** 展开 1.13+ 的 arguments：裸字符串直接留，带 rules 的要先过规则。 */
export function expandArgs(entries: readonly ArgEntry[], env: LaunchEnv): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    if (!rulesAllow(entry.rules, env)) continue
    if (typeof entry.value === 'string') out.push(entry.value)
    else out.push(...entry.value)
  }
  return out
}

/** 1.12 及更早的 minecraftArguments 是空格分隔的一整串。 */
export function splitLegacyArgs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return []
  return raw.split(/\s+/).filter((s) => s !== '')
}

/**
 * 判断一个 library 是「要进 classpath 的普通 jar」还是「要解压的原生库」。
 *
 * 两种时代两种写法：
 * - 1.12 及更早：`"natives": { "windows": "natives-windows" }` + downloads.classifiers
 * - 1.19+：classifier 直接写在 name 里，如 `org.lwjgl:lwjgl:3.3.1:natives-windows`，
 *   downloads.artifact 是存在的
 *
 * 之前只看 `downloads.artifact === undefined` 来判断，导致 1.19+ 的 natives jar
 * 被当成普通库塞进了 classpath——能跑，但多加载了几个无用的 jar。
 */
function isNativeLibrary(lib: Library): boolean {
  if (lib.natives !== undefined) return true
  return /:natives-/.test(lib.name)
}

/**
 * 挑出这个平台上真正需要的 library。
 *
 * 两类被排除：
 * - rules 判定不允许的（比如 macOS 专用的 -XstartOnFirstThread 库）
 * - 原生库：它们不进 classpath，要解压到 natives 目录
 */
export function pickLibraries(
  version: VersionJson,
  env: LaunchEnv,
): { readonly jars: readonly Library[]; readonly natives: readonly Library[] } {
  const jars: Library[] = []
  const natives: Library[] = []
  for (const lib of version.libraries) {
    if (!rulesAllow(lib.rules, env)) continue
    if (isNativeLibrary(lib)) {
      natives.push(lib)
      continue
    }
    if (lib.downloads?.artifact !== undefined) jars.push(lib)
  }
  return { jars, natives }
}

/** libraries 目录 + client jar，按平台分隔符拼成 -cp 的值。 */
export function buildClasspath(
  version: VersionJson,
  env: LaunchEnv,
  librariesDir: string,
  clientJar: string,
): { readonly classpath: string; readonly entries: readonly string[] } {
  const { jars } = pickLibraries(version, env)
  const entries = jars
    .map((lib) => lib.downloads?.artifact?.path)
    .filter((p): p is string => p !== undefined)
    .map((p) => join(librariesDir, ...p.split('/')))
  entries.push(clientJar)
  return {
    classpath: entries.join(env.os === 'windows' ? ';' : ':'),
    entries,
  }
}
