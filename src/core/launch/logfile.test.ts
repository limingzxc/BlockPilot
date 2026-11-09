import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { listLogs, openLogFile } from './logfile.js'

const dir = mkdtempSync(join(tmpdir(), 'bp-log-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('openLogFile 写出内容并能在关闭后读回', async () => {
  const logsDir = join(dir, 'a')
  const sink = openLogFile(logsDir, '1.20.1')
  sink.write('hello')
  sink.write('world')
  await sink.close()

  assert.ok(existsSync(sink.path))
  assert.ok(sink.path.endsWith('-1.20.1.log'))
})

test('文件名里的非法字符被替换', async () => {
  const sink = openLogFile(join(dir, 'b'), 'fabric-loader/0.15.11+1.20.1')
  await sink.close()
  assert.ok(!sink.path.includes('/0.15.11'), '斜杠不能出现在文件名里')
})

test('轮转只删自己的日志，绝不动 latest.log', async () => {
  const logsDir = join(dir, 'c')
  mkdirSync(logsDir, { recursive: true })
  writeFileSync(join(logsDir, 'keep-me-alone.log'), 'x')
  // 制造 15 个时间戳日志，mtime 逐个递增
  for (let i = 0; i < 15; i += 1) {
    const name = `2026-01-01T00-00-${String(i).padStart(2, '0')}-1.20.1.log`
    const full = join(logsDir, name)
    writeFileSync(full, 'x')
    const t = 1000 + i * 10
    utimesSync(full, t, t)
  }

  // 打开第 16 个，触发 prune
  const sink = openLogFile(logsDir, '1.20.1')
  await sink.close()

  const names = readdirSync(logsDir)
  assert.ok(names.includes('keep-me-alone.log'), '游戏原生日志必须保留')

  const ours = names.filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
  assert.ok(ours.length <= 11, `自己的日志应被裁剪到 10 个左右，实际 ${ours.length}`)
})

test('listLogs 标记哪些是游戏原生', async () => {
  const logsDir = join(dir, 'd')
  mkdirSync(logsDir, { recursive: true })
  const sink = openLogFile(logsDir, '1.20.1')
  sink.write('x')
  await sink.close()
  writeFileSync(join(logsDir, 'latest.log'), 'native')

  const logs = listLogs(logsDir)
  assert.equal(logs.length, 2)
  assert.equal(logs.find((l) => l.name === 'latest.log')?.native, true)
  assert.equal(logs.find((l) => l.name !== 'latest.log')?.native, false)
})

test('目录不存在时 listLogs 返回空数组', () => {
  assert.deepEqual(listLogs(join(dir, 'nope')), [])
})
