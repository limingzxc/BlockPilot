import assert from 'node:assert/strict'
import { test } from 'node:test'

import { majorOf, parseJavaProperties } from './probe.js'
import { pickJava, requiredJavaMajor } from './types.js'
import type { JavaInstall } from './types.js'

const SAMPLE = `Property settings:
    java.home = C:\\Program Files\\Java\\jdk-17
    java.vendor = Eclipse Adoptium
    java.version = 17.0.9
    os.arch = amd64
`

test('解析 java -XshowSettings:properties 的 stderr', () => {
  const p = parseJavaProperties(SAMPLE)
  assert.ok(p)
  assert.equal(p.version, '17.0.9')
  assert.equal(p.vendor, 'Eclipse Adoptium')
  assert.equal(p.arch, 'amd64')
})

test('没有 java.version 时返回 null', () => {
  assert.equal(parseJavaProperties('nothing useful here'), null)
})

test('大版本解析：legacy 与新版', () => {
  assert.equal(majorOf('1.8.0_392'), 8)
  assert.equal(majorOf('17.0.9'), 17)
  assert.equal(majorOf('21'), 21)
  assert.equal(majorOf('garbage'), 0)
})

test('MC 版本 → Java 大版本', () => {
  assert.equal(requiredJavaMajor('1.16.5'), 8)
  assert.equal(requiredJavaMajor('1.17'), 17)
  assert.equal(requiredJavaMajor('1.20.4'), 17)
  assert.equal(requiredJavaMajor('1.20.5'), 21)
  // 26.x 的版本 JSON 写的是 majorVersion 25：给 21 会让「Java 21 够用」这种结论骗人
  assert.equal(requiredJavaMajor('26.2'), 25)
  assert.equal(requiredJavaMajor('26.3'), 25)
})

function j(major: number, path = `/jdk-${major}/bin/java`): JavaInstall {
  return { path, version: `${major}.0.0`, major, source: 'scan' }
}

test('pickJava 优先精确匹配', () => {
  const picked = pickJava([j(8), j(17), j(21)], 17)
  assert.equal(picked?.major, 17)
})

test('pickJava 没有精确版本时取最小的更高版本', () => {
  const picked = pickJava([j(8), j(21), j(25)], 17)
  assert.equal(picked?.major, 21)
})

test('pickJava 只有更低版本时返回 null', () => {
  assert.equal(pickJava([j(8)], 17), null)
})
