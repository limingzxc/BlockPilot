import assert from 'node:assert/strict'
import { test } from 'node:test'

import { analyzeLog, primarySignal, survivedAfter } from './crash.js'

function analyze(text: string) {
  return analyzeLog(text.split('\n'))
}

test('Java 版本过低', () => {
  const s = analyze(
    '[main/ERROR]: java.lang.UnsupportedClassVersionError: net/fabricmc/loader/impl/launch/knot/KnotClient has been compiled by a more recent version of the Java Runtime',
  )
  assert.equal(s.length, 1)
  assert.equal(s[0]?.kind, 'java-version')
  assert.equal(s[0]?.severity, 'fatal')
  assert.match(s[0]?.hint ?? '', /java install/)
})

test('内存不足', () => {
  const s = analyze('[Render thread/ERROR]: java.lang.OutOfMemoryError: Java heap space')
  assert.equal(s[0]?.kind, 'out-of-memory')
  assert.match(s[0]?.hint ?? '', /--memory/)
})

test('Fabric 依赖解析失败', () => {
  const s = analyze(
    'net.fabricmc.loader.impl.FormattedException: Mod resolution encountered an incompatible mod set!',
  )
  assert.equal(s[0]?.kind, 'missing-dependency')
})

test('ModLoadingException 是结果不是原因，降级为 warning', () => {
  const s = analyze('net.minecraftforge.fml.ModLoadingException: Mod loading has failed')
  assert.equal(s[0]?.kind, 'mod-load-failed')
  assert.equal(s[0]?.severity, 'warning')
  assert.match(s[0]?.hint ?? '', /这是结果不是原因/)
})

test('真正的依赖缺失仍然是 fatal', () => {
  const s = analyze(
    "net.minecraftforge.fml.MissingDependencyException: Mod ID: 'xyz', Requested by: 'abc'",
  )
  assert.equal(s[0]?.kind, 'missing-dependency')
  assert.equal(s[0]?.severity, 'fatal')
})

test('Mixin 冲突', () => {
  const s = analyze(
    'org.spongepowered.asm.mixin.transformer.throwables.InvalidMixinException: Found a remappable @Shadow annotation',
  )
  assert.equal(s[0]?.kind, 'mixin')
  assert.match(s[0]?.hint ?? '', /移除最近加的那个/)
})

test('natives 缺失', () => {
  const s = analyze('java.lang.UnsatisfiedLinkError: no lwjgl in java.library.path')
  assert.equal(s[0]?.kind, 'natives')
})

test('NoClassDefFoundError: MemoryUtil 也归到 natives', () => {
  const s = analyze(
    'Caused by: java.lang.NoClassDefFoundError: Could not initialize class org.lwjgl.system.MemoryUtil',
  )
  assert.equal(s[0]?.kind, 'natives')
})

test('图形驱动问题', () => {
  const s = analyze('GLFW error 65542: WGL: The driver does not appear to support OpenGL')
  assert.equal(s[0]?.kind, 'graphics')
})

test('重复模组', () => {
  const s = analyze('Duplicate mods found for modid create')
  assert.equal(s[0]?.kind, 'mod-conflict')
  assert.match(s[0]?.hint ?? '', /删掉/)
})

test('未归类异常降级为 warning', () => {
  const s = analyze('Caused by: com.example.SomeRandomException: boom')
  assert.equal(s[0]?.kind, 'mod-crash')
  assert.equal(s[0]?.severity, 'warning')
})

test('同一个 kind 只报第一次（后面是连锁反应）', () => {
  const s = analyze(
    [
      'java.lang.UnsupportedClassVersionError: a',
      'java.lang.UnsupportedClassVersionError: b',
      'java.lang.UnsupportedClassVersionError: c',
    ].join('\n'),
  )
  assert.equal(s.length, 1)
  assert.equal(s[0]?.line, 1)
})

test('普通 INFO 行不会误报', () => {
  const s = analyze(
    [
      '[18:57:18] [Render thread/INFO]: Setting user: Player',
      '[18:57:19] [Render thread/INFO]: Backend library: LWJGL version 3.3.1 build 7',
      '[main/WARN] Mod file x.jar is missing mods.toml file',
    ].join('\n'),
  )
  assert.equal(s.length, 0)
})

test('上下文包含命中行前后内容', () => {
  const lines = ['a', 'b', 'GLFW error 65542', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
  const s = analyzeLog(lines)
  assert.ok((s[0]?.excerpt.length ?? 0) >= 3)
  assert.equal(s[0]?.excerpt[2], 'GLFW error 65542')
})

test('primarySignal 优先 fatal', () => {
  const signals = analyze(
    ['Caused by: com.example.RandomException: x', 'java.lang.OutOfMemoryError: Java heap space'].join(
      '\n',
    ),
  )
  assert.equal(primarySignal(signals)?.kind, 'out-of-memory')
})

test('没有命中时 primarySignal 返回 null', () => {
  assert.equal(primarySignal(analyze('all good')), null)
})

test('不认的令牌归因到认证，而不是当成模组异常', () => {
  const s = analyze(
    'com.mojang.authlib.exceptions.InvalidCredentialsException: Status: 401',
  )
  assert.equal(s[0]?.kind, 'auth-failed')
  assert.equal(s[0]?.severity, 'warning')
  assert.match(s[0]?.hint ?? '', /blockpilot login/)
})

test('survivedAfter：异常之后走到启动里程碑就算活着', () => {
  const lines = [
    '[1] [main/ERROR]: InvalidMixinException: bad shadow',
    '[2] [main/WARN]: Force-disabling mixin FooMixin',
    '[3] [Render thread/INFO]: Backend library: LWJGL version 3.3.3-snapshot',
  ]
  assert.equal(survivedAfter(lines, 1), true)
})

test('survivedAfter：异常之后只有栈帧，没走到里程碑', () => {
  const lines = [
    '[1] [main/ERROR]: InvalidMixinException: bad shadow',
    '\tat org.spongepowered.asm.mixin.MixinInfo.validate(MixinInfo.java:375)',
    '\tat net.minecraft.client.main.Main.main(Main.java:1)',
  ]
  assert.equal(survivedAfter(lines, 1), false)
})

test('survivedAfter：里程碑出现在异常之前不算数', () => {
  const lines = [
    '[1] [Render thread/INFO]: Backend library: LWJGL version 3.3.3-snapshot',
    '[2] [main/ERROR]: InvalidMixinException: bad shadow',
  ]
  assert.equal(survivedAfter(lines, 2), false)
})
