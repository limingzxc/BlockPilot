import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { strToU8, zipSync } from 'fflate'

import { attributeCulprits, buildModIndex, modIdOfJar } from './attribution.js'

function makeMod(
  dir: string,
  fileName: string,
  modId: string,
  opts: { version?: string; name?: string; packages?: readonly string[] } = {},
): void {
  const files: Record<string, Uint8Array> = {
    'fabric.mod.json': strToU8(
      JSON.stringify({
        id: modId,
        version: opts.version ?? '1.0.0',
        ...(opts.name === undefined ? {} : { name: opts.name }),
      }),
    ),
  }
  for (const pkg of opts.packages ?? []) {
    files[`${pkg.replace(/\./g, '/')}/Foo.class`] = strToU8('x')
  }
  writeFileSync(join(dir, fileName), zipSync(files))
}

function withModsDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-attr-'))
  mkdirSync(dir, { recursive: true })
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('按包名把帧归到模组', () => {
  withModsDir((dir) => {
    makeMod(dir, 'sodium.jar', 'sodium', { packages: ['net.caffeinemc.mods.sodium'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['java.lang.NullPointerException', '\tat net.caffeinemc.mods.sodium.Foo.bar(Foo.java:1)'],
      index,
    })
    assert.equal(r.culprits.length, 1)
    assert.equal(r.culprits[0]?.modId, 'sodium')
  })
})

test('多个模组声明同一个包时不指认任何人', () => {
  withModsDir((dir) => {
    // 两个模组都把某个库打包进来了，这时候说「是谁」等于瞎猜
    makeMod(dir, 'a.jar', 'mod-a', { packages: ['com.shared.lib'] })
    makeMod(dir, 'b.jar', 'mod-b', { packages: ['com.shared.lib'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['java.lang.Error', '\tat com.shared.lib.Foo.bar(Foo.java:1)'],
      index,
    })
    assert.equal(r.culprits.length, 0)
    assert.match(r.notes.join(' '), /没有一个能归到已安装的模组/)
  })
})

test('原版与内嵌库的包不参与归属', () => {
  withModsDir((dir) => {
    makeMod(dir, 'm.jar', 'm', { packages: ['net.minecraft.client', 'it.unimi.dsi.fastutil'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'java.lang.Error',
        '\tat net.minecraft.client.Minecraft.run(Minecraft.java:1)',
        '\tat it.unimi.dsi.fastutil.Arrays.swap(Arrays.java:2)',
      ],
      index,
    })
    assert.equal(r.culprits.length, 0)
  })
})

test('帧尾的 jar 名优先于包名', () => {
  withModsDir((dir) => {
    makeMod(dir, 'sodium-fabric-0.5.13.jar', 'sodium', { packages: [] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'java.lang.Error',
        '\tat net.other.Thing.go(Thing.java:1) ~[sodium-fabric-0.5.13.jar%23123!/:?]',
      ],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'sodium')
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /栈帧标明了来源/)
  })
})

test('mixin 处理器方法名直接给出 mod id', () => {
  withModsDir((dir) => {
    makeMod(dir, 'sodium.jar', 'sodium')
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'java.lang.Error',
        'at net.minecraft.class_310.handler$zcb000$sodium$method_1(class_310.java:1)',
      ],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'sodium')
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /mixin 处理器/)
  })
})

test('日志点名 xxx.mixins.json 时算强证据', () => {
  withModsDir((dir) => {
    makeMod(dir, 'controlify.jar', 'controlify')
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'Mixin apply failed controlify.mixins.json:ScreenMixin -> net.minecraft.class_437',
        'java.lang.Error',
      ],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'controlify')
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /controlify\.mixins\.json/)
  })
})

test('根因区段最上面的一帧排第一，表层异常不抢位', () => {
  withModsDir((dir) => {
    makeMod(dir, 'top.jar', 'surface-mod', { packages: ['com.surface'] })
    makeMod(dir, 'deep.jar', 'root-mod', { packages: ['com.deep'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'java.lang.RuntimeException: wrapped',
        '\tat com.surface.A.run(A.java:1)',
        'Caused by: java.lang.NullPointerException',
        '\tat com.deep.B.boom(B.java:42)',
      ],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'root-mod')
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /根因区段最上面的一帧/)
  })
})

test('没有 mods 目录时给出可读的解释而不是空结果', () => {
  const index = buildModIndex('/definitely/not/a/real/dir/bp-attr')
  const r = attributeCulprits({
    lines: ['java.lang.Error', '\tat com.example.A.b(A.java:1)'],
    index,
  })
  assert.equal(r.culprits.length, 0)
  assert.match(r.notes.join(' '), /没有读到任何模组元数据/)
})

test('没有栈帧时说明原因', () => {
  withModsDir((dir) => {
    makeMod(dir, 'a.jar', 'a')
    const index = buildModIndex(dir)
    const r = attributeCulprits({ lines: ['游戏正常退出'], index })
    assert.match(r.notes.join(' '), /没有栈帧/)
  })
})

test('jar 名反查 modId', () => {
  withModsDir((dir) => {
    makeMod(dir, 'jei.jar', 'jei')
    const index = buildModIndex(dir)
    assert.equal(modIdOfJar(index, 'jei.jar%23123!/:?'), 'jei')
    assert.equal(modIdOfJar(index, 'nope.jar'), null)
  })
})

test('读不出元数据的 jar 不进入索引', () => {
  withModsDir((dir) => {
    writeFileSync(join(dir, 'not-a-mod.jar'), zipSync({ 'readme.txt': strToU8('hi') }))
    const index = buildModIndex(dir)
    assert.equal(index.mods.size, 0)
  })
})

test('原因按证据强度排序：根因帧在最前，包名垫后', () => {
  withModsDir((dir) => {
    makeMod(dir, 'x.jar', 'x', { packages: ['com.x.mod'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['java.lang.Error', '\tat com.x.mod.A.b(A.java:1)'],
      index,
    })
    const reasons = r.culprits[0]?.reasons ?? []
    assert.equal(reasons[0], '根因区段最上面的一帧')
    assert.match(reasons[reasons.length - 1] ?? '', /包名属于它/)
  })
})

test('只有 mixin 配置名、没有栈帧时仍然能定位', () => {
  withModsDir((dir) => {
    makeMod(dir, 'c.jar', 'controlify')
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['[1] [main/ERROR]: Mixin apply failed controlify.mixins.json:FooMixin'],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'controlify')
    assert.equal(r.culprits[0]?.frames, 0)
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /controlify\.mixins\.json/)
  })
})

test('证据太弱的候选排在后面，不会盖过根因帧', () => {
  withModsDir((dir) => {
    makeMod(dir, 'a.jar', 'weak', { packages: ['com.weak'] })
    makeMod(dir, 'b.jar', 'strong', { packages: ['com.strong'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: [
        'java.lang.Error',
        '\tat com.weak.A.b(A.java:1)',
        'Caused by: java.lang.NullPointerException',
        '\tat com.strong.B.c(B.java:2)',
      ],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'strong')
    assert.equal(r.culprits[1]?.modId, 'weak')
  })
})

test('前三段包名相同的两个模组，靠更深的包名仍然能区分', () => {
  withModsDir((dir) => {
    // 真实案例：sodium 和 lithium 都在 net.caffeinemc.mods 下。
    // 截断到三段就会判定「有歧义」，两个模组的栈帧全被丢弃。
    makeMod(dir, 'sodium.jar', 'sodium', { packages: ['net.caffeinemc.mods.sodium.client'] })
    makeMod(dir, 'lithium.jar', 'lithium', { packages: ['net.caffeinemc.mods.lithium.common'] })
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['java.lang.Error', '\tat net.caffeinemc.mods.sodium.client.Foo.bar(Foo.java:1)'],
      index,
    })
    assert.equal(r.culprits.length, 1)
    assert.equal(r.culprits[0]?.modId, 'sodium')
    assert.match(r.culprits[0]?.reasons.join(' ') ?? '', /net\.caffeinemc\.mods\.sodium\.client/)
  })
})

test('嵌套 jar 里的类算给外层模组（Fabric API 的 57 个子模块）', () => {
  withModsDir((dir) => {
    const sub = zipSync({
      'fabric/module/fluids/Foo.class': strToU8('x'),
    })
    writeFileSync(
      join(dir, 'fabric-api.jar'),
      zipSync({
        'fabric.mod.json': strToU8(JSON.stringify({ id: 'fabric-api', version: '0.92.0' })),
        'META-INF/jars/fabric-rendering-fluids-v1.jar': sub,
      }),
    )
    const index = buildModIndex(dir)
    const r = attributeCulprits({
      lines: ['java.lang.Error', '\tat fabric.module.fluids.Foo.bar(Foo.java:1)'],
      index,
    })
    assert.equal(r.culprits[0]?.modId, 'fabric-api')
  })
})
