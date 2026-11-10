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
import type { LaunchPlan } from './plan.js'
import type { RunResult } from './run.js'
import { createLauncher } from './run.js'

function planWith(script: string, cwd: string): LaunchPlan {
  return {
    java: process.execPath,
    mainClass: 'FakeMain',
    versionId: 'fake-1.0.0',
    mode: 'offline',
    playerName: 'Player',
    args: ['-e', script],
    cwd,
    classpath: [],
    missing: [],
    assets: null,
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
    const plan = planWith(
      'console.log("hello game"); console.log("ERROR boom"); process.exit(0)',
      dir,
    )
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

test('会话令牌在 tail、日志与事件里都被脱敏', async () => {
  await withTemp(async (dir) => {
    const uuid = '00000000000000000000000000000000'
    const plan = planWith(
      `console.log("Session ID is token:supersecret:${uuid}"); console.log("--accessToken abc.def")`,
      dir,
    )
    const lines: string[] = []
    for await (const ev of createLauncher({ plan, logsDir: join(dir, 'logs') }).run(
      new AbortController().signal,
    )) {
      if (ev.type === 'log' && ev.code === 'game.output') {
        lines.push((ev.data as { line: string }).line)
      }
    }
    const r = await collect(createLauncher({ plan, logsDir: join(dir, 'logs2') }))
    const written = readFileSync(r.logPath ?? '', 'utf8')

    for (const text of [...lines, ...r.tail, written]) {
      assert.doesNotMatch(text, /supersecret/)
      assert.doesNotMatch(text, /abc\.def/)
    }
    assert.ok(lines.some((l) => l.includes(`token:***:${uuid}`)))
  })
})

test('崩溃行的级别是 error（下游 consumer 靠它做 --quiet 过滤）', async () => {
  await withTemp(async (dir) => {
    const plan = planWith(
      'console.log("plain line"); console.log("FATAL kaboom"); process.exit(1)',
      dir,
    )
    const op = createLauncher({ plan })
    const levels: { code: string; level: string }[] = []
    for await (const ev of op.run(new AbortController().signal)) {
      if (ev.type === 'log' && ev.code === 'game.output') {
        levels.push({ code: ev.code, level: ev.level })
      }
    }
    assert.deepEqual(
      levels.map((l) => l.level),
      ['info', 'error'],
    )
  })
})

test('autoStopSeconds 到点杀进程：stopped=true、crashed=false 且发出 autostop 事件', async () => {
  await withTemp(async (dir) => {
    // 假 java 睡 30 秒，0.4 秒后应被 kill
    const plan = planWith('setTimeout(() => {}, 30000)', dir)
    const events: string[] = []
    const op = createLauncher({ plan, autoStopSeconds: 0.4 })
    let result: RunResult | undefined
    for await (const ev of op.run(new AbortController().signal)) {
      if (ev.type === 'log') events.push(ev.code)
      if (ev.type === 'result') result = ev.value
    }
    assert.ok(events.includes('launch.autostop'))
    assert.equal(result?.stopped, true)
    assert.equal(result?.crashed, false)
  })
})

test('Ctrl+C 中断：stopped=true、aborted=true，不报成崩溃', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('console.log("running"); setTimeout(() => {}, 30000)', dir)
    const controller = new AbortController()
    const events: string[] = []
    let result: RunResult | undefined
    const timer = setTimeout(() => controller.abort(), 200)
    for await (const ev of createLauncher({ plan }).run(controller.signal)) {
      if (ev.type === 'log') events.push(ev.code)
      if (ev.type === 'result') result = ev.value
    }
    clearTimeout(timer)
    assert.ok(events.includes('launch.aborted'))
    assert.equal(result?.stopped, true)
    assert.equal(result?.aborted, true)
    assert.equal(result?.crashed, false)
  })
})

test('结尾没有换行符的半行也会进入 tail 与日志', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('process.stdout.write("last line without newline")', dir)
    const r = await collect(createLauncher({ plan, logsDir: join(dir, 'logs') }))
    assert.ok(r.tail.includes('last line without newline'))
    assert.match(readFileSync(r.logPath ?? '', 'utf8'), /last line without newline/)
  })
})

test('实例目录不存在：报 INSTANCE_DIR_MISSING，不把它说成 java 的问题（issue #9）', async () => {
  await withTemp(async (dir) => {
    const plan = planWith('console.log("never runs")', join(dir, 'no-such-instance'))
    await assert.rejects(
      () => collect(createLauncher({ plan })),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'INSTANCE_DIR_MISSING')
        assert.match(err.message, /实例目录不存在/)
        return true
      },
    )
  })
})

test('进程活着但日志停在栈帧上：--stop 到点也要报崩溃（issue #2）', async () => {
  await withTemp(async (dir) => {
    // 游戏死在第 12 秒、进程挂到时限：日志以栈帧收尾，之后一片安静
    const script = [
      'console.log("[Render thread/ERROR]: Couldn\'t set icon")',
      'console.log("java.nio.file.NoSuchFileException: assets/objects/5f/5ff0")',
      'console.log("\\tat net.minecraft.client.main.Main.main(SourceFile:256)")',
      'setTimeout(() => {}, 5000)',
    ].join(';')
    const r = await collect(
      createLauncher({
        plan: planWith(script, dir),
        autoStopSeconds: 1,
        heartbeatGraceMs: 200,
      }),
    )
    assert.equal(r.diedBeforeStop, true)
    assert.equal(r.crashed, true)
    // 「到点结束」会被读成「跑完了」，这种情况不能报成正常
    assert.equal(r.stopped, false)
  })
})

test('日志安静但结尾是普通 INFO：仍算正常到点结束', async () => {
  await withTemp(async (dir) => {
    const script = [
      'console.log("[Render thread/INFO]: Sound engine started")',
      'setTimeout(() => {}, 5000)',
    ].join(';')
    const r = await collect(
      createLauncher({
        plan: planWith(script, dir),
        autoStopSeconds: 1,
        heartbeatGraceMs: 200,
      }),
    )
    assert.equal(r.diedBeforeStop, false)
    assert.equal(r.stopped, true)
  })
})
