/**
 * 版本号只能有一个来源。
 *
 * `package.json`、User-Agent、MCP 握手、启动参数里的 `launcher_version` 曾经各写
 * 一份 `0.0.1`，升版本漏一处就会在日志或协议握手里露出旧号。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { USER_AGENT } from './user-agent.js'
import { VERSION } from './version-info.js'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version?: string
}

test('package.json 的 version 与 VERSION 一致', () => {
  assert.equal(pkg.version, VERSION, '升版本时 package.json 与 src/core/version-info.ts 要一起改')
})

test('User-Agent 用同一个版本号', () => {
  assert.equal(USER_AGENT, `BlockPilot/${VERSION}`)
})

test('VERSION 是 x.y.z 形状', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/)
})
