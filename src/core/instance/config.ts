/**
 * 实例级配置：`<gameDir>/.blockpilot/config.json`。
 *
 * 为什么不是命令行全局默认值：`--memory` 是「这次启动用多少」，而
 * 「这个 300 模组的包要 6 GB」是实例的属性。每次 run 都手打一遍既容易忘，
 * 也会让 `run` 与 `launch` 的默认值分叉。
 *
 * 优先级固定为：命令行 > 实例配置 > 程序默认。配置文件损坏时报
 * `CONFIG_CORRUPT`，不静默忽略——用户改了 JSON 却不知道没生效更糟。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BlockPilotError } from '../errors.js'

const CONFIG_VERSION = 1
const CONFIG_DIR = '.blockpilot'
const CONFIG_NAME = 'config.json'
const MIN_MEMORY = 512
const MAX_MEMORY = 65_536

export interface InstanceConfig {
  readonly version: 1
  /** 最大堆内存（MB） */
  readonly memoryMiB?: number
  /** 这个实例固定用哪个 java */
  readonly javaPath?: string
  /** 追加到 -Xmx 之后的 JVM 参数 */
  readonly jvmArgs?: readonly string[]
}

export function configPath(gameDir: string): string {
  return join(gameDir, CONFIG_DIR, CONFIG_NAME)
}

function corrupt(message: string): BlockPilotError {
  return new BlockPilotError('CONFIG_CORRUPT', message, {
    hint: '删掉 .blockpilot/config.json 会回到默认值；也可以手工修正后重试',
  })
}

/** 校验外部输入。未知字段忽略，方便以后加字段而不炸旧版本。 */
export function parseConfig(raw: unknown): InstanceConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw corrupt('config.json 不是 JSON 对象')
  }
  const o = raw as Record<string, unknown>
  if (o.version !== CONFIG_VERSION) {
    throw corrupt(`config.json 的版本是 ${String(o.version)}，本程序只认 ${CONFIG_VERSION}`)
  }

  const out: {
    version: 1
    memoryMiB?: number
    javaPath?: string
    jvmArgs?: readonly string[]
  } = { version: CONFIG_VERSION }

  const memory = o.memoryMiB
  if (memory !== undefined) {
    if (
      typeof memory !== 'number' ||
      !Number.isInteger(memory) ||
      memory < MIN_MEMORY ||
      memory > MAX_MEMORY
    ) {
      throw corrupt(`memoryMiB 必须是 ${MIN_MEMORY}–${MAX_MEMORY} 的整数，实际 ${String(memory)}`)
    }
    out.memoryMiB = memory
  }

  const java = o.javaPath
  if (java !== undefined) {
    if (typeof java !== 'string' || java.trim() === '') {
      throw corrupt('javaPath 必须是非空字符串')
    }
    out.javaPath = java
  }

  const args = o.jvmArgs
  if (args !== undefined) {
    if (
      !Array.isArray(args) ||
      args.length > 32 ||
      args.some((a) => typeof a !== 'string' || a === '')
    ) {
      throw corrupt('jvmArgs 必须是最多 32 个非空字符串的数组')
    }
    out.jvmArgs = args as string[]
  }

  return out
}

/** 没有配置文件返回 `{ version: 1 }`；有但坏了抛 CONFIG_CORRUPT。 */
export function readConfig(gameDir: string): InstanceConfig {
  const path = configPath(gameDir)
  if (!existsSync(path)) return { version: CONFIG_VERSION }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw corrupt(`config.json 不是合法 JSON：${path}`)
  }
  return parseConfig(parsed)
}

/** 原子写。`undefined` 字段不会写进文件。 */
export function writeConfig(gameDir: string, config: InstanceConfig): string {
  const path = configPath(gameDir)
  mkdirSync(dirname(path), { recursive: true })
  const body = {
    version: CONFIG_VERSION,
    ...(config.memoryMiB === undefined ? {} : { memoryMiB: config.memoryMiB }),
    ...(config.javaPath === undefined ? {} : { javaPath: config.javaPath }),
    ...(config.jvmArgs === undefined ? {} : { jvmArgs: config.jvmArgs }),
  }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameSync(tmp, path)
  return path
}
