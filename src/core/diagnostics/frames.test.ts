import assert from 'node:assert/strict'
import test from 'node:test'

import { jarNameOf, parseFrame, parseFrames, rootCauseStart } from './frames.js'

test('解析普通 Java 栈帧', () => {
  const f = parseFrame('\tat com.example.mod.Foo.bar(Foo.java:42)', 7)
  assert.ok(f)
  assert.equal(f.className, 'com.example.mod.Foo')
  assert.equal(f.method, 'bar')
  assert.equal(f.sourceFile, 'Foo.java')
  assert.equal(f.sourceLine, 42)
  assert.equal(f.line, 7)
})

test('带完整日志前缀的帧也能解析', () => {
  const f = parseFrame('[20:20:07] [Render thread/ERROR]: \tat net.example.A.b(A.java:1)', 3)
  assert.ok(f)
  assert.equal(f.className, 'net.example.A')
  assert.equal(f.method, 'b')
})

test('Forge 在帧尾附的 jar 名要抠出来', () => {
  const line =
    '\tat com.example.mod.Foo.bar(Foo.java:42) ~[foo-1.0.0.jar%23123!/:?] {re:classloading}'
  const f = parseFrame(line, 1)
  assert.ok(f)
  assert.equal(f.sourceJar, 'foo-1.0.0.jar')
})

test('Fabric mixin 处理器方法名里带 mod id', () => {
  const line = 'at net.minecraft.class_310.handler$zcb000$sodium$method_15563(class_310.java:1234)'
  const f = parseFrame(line, 1)
  assert.ok(f)
  assert.equal(f.mixinModId, 'sodium')
  assert.equal(f.method, 'handler$zcb000$sodium$method_15563')
})

test('构造函数与静态初始化块不丢', () => {
  assert.equal(parseFrame('at com.example.A.<init>(A.java:10)', 1)?.method, '<init>')
  assert.equal(parseFrame('at com.example.A.<clinit>(A.java:3)', 1)?.method, '<clinit>')
})

test('Lambda 隐藏类名里的斜杠地址要去掉', () => {
  const f = parseFrame('at com.example.A$$Lambda$1/0x0000000800c0.run(Unknown Source)', 1)
  assert.ok(f)
  assert.equal(f.className, 'com.example.A$$Lambda$1')
  assert.equal(f.method, 'run')
})

test('Native Method 与 Unknown Source 算帧', () => {
  assert.ok(parseFrame('at com.example.A.native(Native Method)', 1))
  assert.ok(parseFrame('at com.example.A.hidden(Unknown Source)', 1))
})

test('含 "at " 的英文句子不是栈帧', () => {
  // 反例：括号里的内容不是合法的源码位置
  assert.equal(parseFrame('Failed at some point (we think)', 1), null)
  assert.equal(parseFrame('  looking at com.example.Foo.bar(because)', 1), null)
  assert.equal(parseFrame('Mixin apply failed at sodium.mixins.json', 1), null)
})

test('jar 名提取，去掉 ModLauncher 的 %23 修饰', () => {
  assert.equal(jarNameOf('foo.jar%23123!/:?'), 'foo.jar')
  assert.equal(jarNameOf('jei-1.20.1-forge-15.74.0.229.jar:?'), 'jei-1.20.1-forge-15.74.0.229.jar')
  assert.equal(jarNameOf('no-extension'), null)
})

test('根因区段从最后一条 Caused by 开始', () => {
  const lines = [
    'java.lang.RuntimeException: outer',
    '\tat com.example.A.run(A.java:1)',
    'Caused by: java.lang.NullPointerException',
    '\tat com.example.B.boom(B.java:42)',
  ]
  assert.equal(rootCauseStart(lines), 2)
})

test('没有 Caused by 时根因区段从头开始', () => {
  assert.equal(rootCauseStart(['java.lang.Error', '\tat A.b(A.java:1)']), 0)
})

test('parseFrames 保持顺序并跳过非帧行', () => {
  const frames = parseFrames([
    '[1] [main/ERROR]: java.lang.RuntimeException: boom',
    '\tat com.a.A.x(A.java:1)',
    '... 12 more',
    'Caused by: java.lang.Error',
    '\tat com.b.B.y(B.java:2)',
  ])
  assert.equal(frames.length, 2)
  assert.equal(frames[0]?.className, 'com.a.A')
  assert.equal(frames[1]?.className, 'com.b.B')
})

test('Kotlin 的 .kt 帧不能丢（controlify 这类模组全是 Kotlin）', () => {
  const f = parseFrame('at dev.isxander.controlify.utils.RenderUtils.blit(RenderUtils.kt:88)', 1)
  assert.ok(f)
  assert.equal(f.className, 'dev.isxander.controlify.utils.RenderUtils')
  assert.equal(f.sourceFile, 'RenderUtils.kt')
  assert.equal(f.sourceLine, 88)
})

test('Scala 之类只要形如 名字.扩展名:行号 都接受', () => {
  assert.ok(parseFrame('at com.example.A.b(A.scala:12)', 1))
  assert.equal(parseFrame('at com.example.A.b(some prose here)', 1), null)
})
