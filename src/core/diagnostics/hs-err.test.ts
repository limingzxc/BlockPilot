import assert from 'node:assert/strict'
import test from 'node:test'

import { analyzeHsErr, detectFormat, parseHsErrFrames } from './hs-err.js'

const HS_ERR = `# A fatal error has been detected by the Java Runtime Environment:
#
#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ff8a2b1c123, pid=1234, tid=5678
#
# JRE version: OpenJDK Runtime Environment (17.0.8+7) (build 17.0.8+7)
# Java VM: OpenJDK 64-Bit Server VM (17.0.8+7, mixed mode, sharing, tiered, compressed oops, g1 gc, windows-amd64)
# Problematic frame:
# C  [lwjgl.dll+0x1a2b]
#
# Core dump will be written. Default location: C:\\mc\\hs_err_pid1234.mdmp
#
---------------  T H R E A D  ---------------

Current thread (0x0000000012345678):  JavaThread "Render thread" [_thread_in_native, id=5678]

Java frames: (J=compiled Java code, j=interpreted, Vv=VM code)
j  org.lwjgl.system.JNI.invokePV(JJ)V+8
j  com.example.render.Renderer.render()V+42
j  net.minecraft.client.Minecraft.run()V+100
v  ~StubRoutines::call_stub
`

test('认出 hs_err 与普通日志', () => {
  assert.equal(detectFormat(HS_ERR), 'hs-err')
  assert.equal(detectFormat('---- Minecraft Crash Report ----\nDescription: x'), 'crash-report')
  assert.equal(detectFormat('[12:00:00] [main/INFO]: hello'), 'log')
})

test('访问违例 + lwjgl：归到显卡类，并带出信号', () => {
  const signals = analyzeHsErr(HS_ERR.split('\n'))
  assert.equal(signals.length, 1)
  assert.equal(signals[0]?.kind, 'graphics')
  assert.equal(signals[0]?.severity, 'fatal')
  assert.match(signals[0]?.message ?? '', /EXCEPTION_ACCESS_VIOLATION/)
  assert.match(signals[0]?.hint ?? '', /显卡驱动/)
})

test('非显卡的原生库崩溃归到 natives', () => {
  const text = HS_ERR.replace('lwjgl.dll', 'some-mod-native.dll')
  const signals = analyzeHsErr(text.split('\n'))
  assert.equal(signals[0]?.kind, 'natives')
})

test('OutOfMemoryError 优先于信号分类', () => {
  const text = `${HS_ERR}\n# OutOfMemoryError: Java heap space`
  assert.equal(analyzeHsErr(text.split('\n'))[0]?.kind, 'out-of-memory')
})

test('Java frames 段转成栈帧，跳过 VM 帧', () => {
  const frames = parseHsErrFrames(HS_ERR.split('\n'))
  assert.equal(frames.length, 3)
  assert.equal(frames[0]?.className, 'org.lwjgl.system.JNI')
  assert.equal(frames[1]?.className, 'com.example.render.Renderer')
  assert.equal(frames[2]?.className, 'net.minecraft.client.Minecraft')
  assert.equal(frames[0]?.sourceFile, undefined, 'hs_err 没有源码位置')
})

test('不是 hs_err 的文本不产生结论', () => {
  assert.deepEqual(analyzeHsErr(['[12:00:00] hello']), [])
})
