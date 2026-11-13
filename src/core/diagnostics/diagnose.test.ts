/**
 * createDiagnose 的 interface 级测试（评审候选 5）。
 *
 * 此前 attribution.test 直接调 buildModIndex / attributeCulprits —— 测的是
 * 内部函数对，编排（把归属并进 primary hint、verdict 判定）零覆盖。
 * 这里穿过 Operation interface：造真文件（日志 + jar），走 run() → collect()。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { collect } from '../events/operation.js'
import { createDiagnose } from './index.js'

const LOG = [
  '[1] [main/ERROR]: Mixin apply failed controlify.mixins.json:FooMixin',
  'java.lang.RuntimeException: boom',
  '\tat net.minecraft.client.Minecraft.tick(Minecraft.java:1)',
  'Caused by: java.lang.NullPointerException: null',
  '\tat com.demo.mod.Main.boom(Main.java:42)',
].join('\n')

function withInstance(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-'))
  mkdirSync(join(dir, 'logs'), { recursive: true })
  mkdirSync(join(dir, 'mods'), { recursive: true })
  writeFileSync(join(dir, 'logs', '2026-10-25T00-00-00-1.20.1.log'), LOG)
  writeFileSync(
    join(dir, 'mods', 'demo-mod.jar'),
    zipSync({
      'fabric.mod.json': strToU8(JSON.stringify({ id: 'demo-mod', version: '1.0.0' })),
      'com/demo/mod/Main.class': strToU8('x'),
    }),
  )
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('穿过 interface：mixin 崩溃被归到具体模组，hint 带上主语', async () => {
  await withInstance(async (dir) => {
    const r = await collect(
      createDiagnose({
        logPath: join(dir, 'logs', '2026-10-25T00-00-00-1.20.1.log'),
        modsDir: join(dir, 'mods'),
      }),
    )
    assert.equal(r.verdict, 'crash')
    assert.equal(r.primary?.kind, 'mixin')
    // 归属结果必须并进 hint——「异常来自谁」是这条诊断的主语
    assert.match(r.primary?.hint ?? '', /本次崩在 demo-mod/)
    assert.equal(r.culprits[0]?.modId, 'demo-mod')
    assert.equal(r.frameCount, 2)
  })
})

test('日志不存在：failed 事件带 LOG_NOT_FOUND，collect 抛出', async () => {
  await assert.rejects(
    () => collect(createDiagnose({ logPath: join(tmpdir(), 'bp-no-such-dir', 'nope.log') })),
    (err: Error & { code?: string }) => err.code === 'LOG_NOT_FOUND',
  )
})

test('没有异常的日志：verdict=clean，没有 culprits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-clean-'))
  const logPath = join(dir, 'x.log')
  writeFileSync(logPath, '[1] [main/INFO]: Setting user: Player\n[2] [main/INFO]: Stopping!')
  try {
    const r = await collect(createDiagnose({ logPath }))
    assert.equal(r.verdict, 'clean')
    assert.equal(r.culprits.length, 0)
    assert.equal(r.primary, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有 mods 目录：仍然给出结论，并解释为什么定位不到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-nomods-'))
  const logPath = join(dir, 'x.log')
  writeFileSync(logPath, LOG)
  try {
    const r = await collect(createDiagnose({ logPath, modsDir: join(dir, 'missing') }))
    assert.equal(r.verdict, 'crash')
    assert.equal(r.culprits.length, 0)
    assert.match(r.attributionNotes.join(' '), /没有读到任何模组元数据/)
    // 定位不到时 hint 不应被改写
    assert.doesNotMatch(r.primary?.hint ?? '', /本次崩在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index 生命周期是参数：注入的索引优先，不再扫 mods 目录', async () => {
  const { buildModIndex } = await import('./attribution.js')
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-index-'))
  try {
    // 磁盘上的 mods 目录里没有 demo-mod；注入的索引里有
    mkdirSync(join(dir, 'mods'), { recursive: true })
    const indexPath = join(dir, 'index-src', 'mods')
    mkdirSync(indexPath, { recursive: true })
    writeFileSync(
      join(indexPath, 'demo-mod.jar'),
      zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'demo-mod', version: '1.0.0' })),
        'com/demo/mod/Main.class': strToU8('x'),
      }),
    )
    const index = buildModIndex(indexPath)

    const logPath = join(dir, 'x.log')
    writeFileSync(logPath, LOG)
    const r = await collect(createDiagnose({ logPath, modsDir: join(dir, 'mods'), index }))
    assert.equal(r.culprits[0]?.modId, 'demo-mod')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fatal 信号之后游戏仍在推进：降级 inconclusive，措辞不说「崩在」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-survived-'))
  const logPath = join(dir, 'x.log')
  // 前半段是一条 fatal 的 mixin 异常，后半段是启动继续推进到 LWJGL——
  // 这正是「Controlify 的 mixin 被禁用但游戏照跑」的形状
  const lines = [
    '[1] [main/ERROR]: Mixin apply failed controlify.mixins.json:FooMixin',
    'java.lang.RuntimeException: boom',
    '\tat com.demo.mod.Main.boom(Main.java:42)',
    ...Array.from({ length: 20 }, (_, i) => `[${i + 4}] [Render thread/INFO]: ticking ${i}`),
    '[99] [Render thread/INFO]: Backend library: LWJGL version 3.3.3-snapshot',
  ]
  writeFileSync(logPath, lines.join('\n'))
  mkdirSync(join(dir, 'mods'), { recursive: true })
  writeFileSync(
    join(dir, 'mods', 'demo-mod.jar'),
    zipSync({
      'fabric.mod.json': strToU8(JSON.stringify({ id: 'demo-mod', version: '1.0.0' })),
      'com/demo/mod/Main.class': strToU8('x'),
    }),
  )
  try {
    const r = await collect(createDiagnose({ logPath, modsDir: join(dir, 'mods') }))
    assert.equal(r.verdict, 'inconclusive')
    // 仍然给嫌疑人，但措辞必须留退路
    assert.equal(r.culprits.length > 0, true)
    assert.doesNotMatch(r.primary?.hint ?? '', /本次崩在/)
    assert.match(r.primary?.hint ?? '', /未必是它导致的/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('可恢复的 mixin 告警：severity 不是 fatal，也不指向任何模组（issue #8）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-diag-recoverable-'))
  try {
    const modsDir = join(dir, 'mods')
    mkdirSync(modsDir, { recursive: true })
    writeFileSync(
      join(modsDir, 'controlify.jar'),
      zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'controlify', version: '3.0.0' })),
        'dev/isxander/controlify/mixins/FooMixin.class': strToU8('x'),
      }),
    )
    const logPath = join(dir, 'x.log')
    const lines = [
      '[1] [main/WARN]: org.spongepowered.asm.mixin.transformer.throwables.InvalidMixinException:',
      '  Found a remappable @Shadow annotation on non-remappable field controlify.mixins.json:FooMixin',
      '\tat com.demo.Main(Main.java:1)',
      '[3] [Render thread/INFO]: Backend library: LWJGL version 3.3.3',
      '[4] [Render thread/INFO]: Sound engine started',
      '[5] [main/INFO]: Stopping! (Ctrl+C)',
    ]
    writeFileSync(logPath, lines.join('\n'))

    const r = await collect(createDiagnose({ logPath, modsDir }))
    // 人话输出说的「没有致命异常」必须和 JSON 一致
    assert.notEqual(r.verdict, 'crash')
    assert.equal(r.primary?.severity, 'warning')
    assert.equal(r.primary?.recoverable, true)
    // 可恢复的那条不点名：点名会让用户去删 controlify
    assert.equal(r.culprits.length, 0)
    assert.match(r.attributionNotes.join(' '), /可恢复的 mixin/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
