import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { configPath, parseConfig, readConfig, writeConfig } from './config.js'

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-config-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('没有配置文件时返回空配置', () => {
  withTemp((dir) => {
    assert.deepEqual(readConfig(dir), { version: 1 })
  })
})

test('写入后能原样读回，且不写 undefined 字段', () => {
  withTemp((dir) => {
    const path = writeConfig(dir, {
      version: 1,
      memoryMiB: 6144,
      javaPath: '/opt/java/bin/java',
      jvmArgs: ['-XX:+UseG1GC', '-XX:+AlwaysPreTouch'],
    })
    assert.equal(path, configPath(dir))
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /undefined/)
    assert.deepEqual(readConfig(dir), {
      version: 1,
      memoryMiB: 6144,
      javaPath: '/opt/java/bin/java',
      jvmArgs: ['-XX:+UseG1GC', '-XX:+AlwaysPreTouch'],
    })
  })
})

test('未知字段忽略，方便以后加字段', () => {
  assert.deepEqual(parseConfig({ version: 1, futureField: true }), { version: 1 })
})

test('非法内存、版本、jvmArgs 都报 CONFIG_CORRUPT', () => {
  for (const raw of [
    { version: 1, memoryMiB: 128 },
    { version: 1, memoryMiB: 4096.5 },
    { version: 1, memoryMiB: '4096' },
    { version: 2 },
    { version: 1, jvmArgs: ['ok', ''] },
    { version: 1, javaPath: '  ' },
  ]) {
    assert.throws(
      () => parseConfig(raw),
      (err: Error & { code?: string }) => err.code === 'CONFIG_CORRUPT',
      JSON.stringify(raw),
    )
  }
})

test('坏 JSON 也报 CONFIG_CORRUPT，不是静默忽略', () => {
  withTemp((dir) => {
    mkdirSync(dirname(configPath(dir)), { recursive: true })
    writeFileSync(configPath(dir), '{ nope')
    assert.throws(
      () => readConfig(dir),
      (err: Error & { code?: string }) => err.code === 'CONFIG_CORRUPT',
    )
  })
})
