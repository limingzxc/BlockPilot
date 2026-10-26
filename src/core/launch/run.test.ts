/**
 * createLauncher 的 interface 级测试（评审候选 5）。
 *
 * 此前 launch.test 只测 buildLaunchPlan 纯函数——进程编排（跨 chunk 拼行、
 * tail 环、退出码映射、日志落盘、abort/超时）零覆盖。
 * 这里用 `process.execPath -e <script>` 当假 java：真进程、真管道、真退出码。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collect } from '../operation.js'
import { createLauncher } from './run.js'
import type { LaunchPlan } from './plan.js'

function planWith(script: string, cwd: string): LaunchPlan {
  return {
    java: process.execPath,
    mainClass: 'FakeMain',
    versionId: 'fake-1.0.0',
    args: ['-e', script],
    cwd,
    classpath: [],
    missing: [],
    commandLine: 'fake',
  }
}

function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-run-'))
  mkdirSync(dir, { recursive: true })
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('正常退出：退出码 0、行数正确、日志落盘', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('console.log("hello game"); console.log("ERROR boom"); process.exit(0)', dir)
    const r = await collect(createLauncher({ plan, logsDir: join(dir, 'logs') }))
    assert.equal(r.exitCode, 0)
    assert.equal(r.crashed, false)
    assert.equal(r.lineCount, 2)
    assert.deepEqual(r.tail, ['hello game', 'ERROR boom'])
    assert.ok(r.logPath !== undefined && existsSync(r.logPath))
    const written = readFileSync(r.logPath, 'utf8')
    assert.match(written, /hello game/)
    assert.match(written, /ERROR boom/)
  })
})

test('异常退出：crashed=true，退出码原样透出', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('console.error("Caused by: something bad"); process.exit(3)', dir)
    const r = await collect(createLauncher({ plan }))
    assert.equal(r.exitCode, 3)
    assert.equal(r.crashed, true)
    assert.ok(r.tail.some((l) => l.includes('Caused by')))
    assert.equal(r.logPath, undefined, '没给 logsDir 就不落盘')
  })
})

test('崩溃行的级别是 error（下游 consumer 靠它做 --quiet 过滤）', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('console.log("plain line"); console.log("FATAL kaboom"); process.exit(1)', dir)
    const op = createLauncher({ plan })
    const levels: { code: string; level: string }[] = []
    for await (const ev of op.run(new AbortController().signal)) {
      if (ev.type === 'log' && ev.code === 'game.output') {
        levels.push({ code: ev.code, level: ev.level })
      }
    }
    assert.deepEqual(levels.map((l) => l.level), ['info', 'error'])
  })
})

test('autoStopSeconds 到点杀进程：crashed=true 且发出 autostop 事件', async () => {
  await withTemp(async (dir) => {
    // 假 java 睡 30 秒，0.4 秒后应被 kill
    const plan = planWith('setTimeout(() => {}, 30000)', dir)
    const events: string[] = []
    const op = createLauncher({ plan, autoStopSeconds: 0.4 })
    let result
    for await (const ev of op.run(new AbortController().signal)) {
      if (ev.type === 'log') events.push(ev.code)
      if (ev.type === 'result') result = ev.value
    }
    assert.ok(events.includes('launch.autostop'))
    assert.equal(result?.crashed, true)
  })
})
