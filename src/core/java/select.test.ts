import assert from 'node:assert/strict'
import test from 'node:test'

import { chooseJava, selectJava } from './select.js'
import type { JavaInstall, JavaScanResult } from './types.js'

const j = (major: number, source: JavaInstall['source'] = 'scan'): JavaInstall => ({
  path: `/java/${major}/bin/java`,
  version: `${major}.0.1`,
  major,
  source,
})

test('有版本要求：精确命中优先，managed 优先于系统', () => {
  assert.equal(chooseJava([j(21), j(17, 'managed'), j(17, 'path')], 17)?.path, '/java/17/bin/java')
  assert.equal(chooseJava([j(17, 'path')], 17)?.source, 'path')
})

test('有版本要求但只有更高版本：取最小的更高版本', () => {
  assert.equal(chooseJava([j(21), j(25)], 17)?.major, 21)
})

test('完全没有匹配：null，而不是硬塞一个', () => {
  assert.equal(chooseJava([j(8)], 17), null)
  assert.equal(chooseJava([], 17), null)
})

test('没有版本要求：按最高版本兜底', () => {
  assert.equal(chooseJava([j(8), j(21), j(17)], undefined)?.major, 21)
})

test('selectJava：显式路径直接通过，不探测', async () => {
  let scanned = false
  const r = await selectJava({
    explicit: process.execPath, // 必须真实存在：不存在的路径现在会直接报错
    layoutRoot: '/root',
    scan: async () => {
      scanned = true
      return { installs: [], rejected: [] }
    },
  })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.path, process.execPath)
  assert.equal(scanned, false)
})

test('selectJava：显式路径不存在时直接报错，不去 spawn', async () => {
  const r = await selectJava({ explicit: '/nope/java', layoutRoot: '/root' })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.message : '', /不存在/)
})

test('selectJava：找不到时给出人话错误与已发现的版本', async () => {
  const scan = async (): Promise<JavaScanResult> => ({ installs: [j(8)], rejected: [] })
  const r = await selectJava({ versionId: '1.20.1', layoutRoot: '/root', scan })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.needMajor, 17)
  assert.match(r.ok === false ? r.message : '', /Java 17/)
  assert.match(r.ok === false ? r.message : '', /本机：8/)
})

test('selectJava：命中时把完整 install 一起带出', async () => {
  const scan = async (): Promise<JavaScanResult> => ({ installs: [j(17, 'managed')], rejected: [] })
  const r = await selectJava({ versionId: '1.20.1', layoutRoot: '/root', scan })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.install?.source, 'managed')
})
