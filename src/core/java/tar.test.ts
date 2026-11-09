import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import type { TarEntry } from './tar.js'
import { readTar, readTarGz, writeTarEntries } from './tar.js'

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-tar-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function entry(name: string, data: string, mode = 0o644): TarEntry {
  return { name, size: data.length, mode, type: 'file', data: new TextEncoder().encode(data) }
}

/** 手搓一个 ustar 头。测试里既用来造合法包，也用来造坏包。 */
function ustarBlock(opts: {
  name: string
  size: number
  mode?: number
  typeflag?: string
  prefix?: string
  magic?: string
}): Uint8Array {
  const block = new Uint8Array(512)
  const enc = new TextEncoder()
  const octal = (n: number, len: number): string => `${n.toString(8).padStart(len - 1, '0')}\0`
  const put = (text: string, at: number, len: number): void => {
    block.set(enc.encode(text).subarray(0, len), at)
  }
  put(opts.name, 0, 100)
  put(octal(opts.mode ?? 0o644, 8), 100, 8)
  put(octal(0, 8), 108, 8) // uid
  put(octal(0, 8), 116, 8) // gid
  put(octal(opts.size, 12), 124, 12)
  put(octal(0, 12), 136, 12) // mtime
  put('        ', 148, 8) // 先放空格算校验
  put(opts.typeflag ?? '0', 156, 1)
  put(opts.magic ?? 'ustar\0', 257, 6)
  put('00', 263, 2)
  put(opts.prefix ?? '', 345, 155)

  let sum = 0
  for (const b of block) sum += b
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
  return block
}

test('读 GNU tar 打的真包（用系统 tar 生成，模拟 Adoptium 的产出方式）', () => {
  withTemp((dir) => {
    // 用 buffer 写进 .tar 再手动 gzip，避免外部 tar 直接出 .tar.gz 的差异
    const tarPath = join(dir, 'plain.tar')
    writeTarFile(tarPath, [
      { name: 'jdk-21/bin/java', body: '#!/bin/sh\necho fake\n', mode: 0o755 },
      { name: 'jdk-21/lib/modules', body: 'fake modules'.repeat(100), mode: 0o644 },
      { name: 'jdk-21/release', body: 'JAVA_VERSION="21"\n', mode: 0o644 },
    ])

    const entries = readTar(new Uint8Array(readFileSync(tarPath)))
    assert.equal(entries.length, 3)
    const java = entries.find((e) => e.name === 'jdk-21/bin/java')
    assert.ok(java)
    assert.equal(java.type, 'file')
    assert.equal(java.mode & 0o111, 0o111, 'bin/java 必须带可执行位')
  })
})

function writeTarFile(path: string, files: { name: string; body: string; mode: number }[]): void {
  const blocks: Uint8Array[] = []
  for (const f of files) {
    blocks.push(ustarBlock({ name: f.name, size: f.body.length, mode: f.mode }))
    const data = new TextEncoder().encode(f.body)
    blocks.push(data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad > 0) blocks.push(new Uint8Array(pad))
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((s, b) => s + b.length, 0)
  const buf = new Uint8Array(total)
  let at = 0
  for (const b of blocks) {
    buf.set(b, at)
    at += b.length
  }
  writeFileSync(path, buf)
}

test('GNU 长名条目（typeflag L）：超过 100 字符的路径', () => {
  const longName = `jdk-21.0.5+11-jre/lib/security/policy/unlimited/${'x'.repeat(80)}.txt`
  assert.ok(longName.length > 100)

  const nameBytes = new TextEncoder().encode(longName)
  const longBlock = ustarBlock({ name: '././@LongLink', size: nameBytes.length, typeflag: 'L' })
  const fileBlock = ustarBlock({ name: longName.slice(0, 90), size: 5 })
  const data = new TextEncoder().encode('hello')

  const buf = new Uint8Array(512 * 2 + 512 + 512 + 1024)
  buf.set(longBlock, 0)
  buf.set(nameBytes, 512)
  buf.set(fileBlock, 1024)
  buf.set(data, 1536)
  // 文件数据补齐到 512
  buf.set(new Uint8Array(512 - 5), 1536 + 5)
  buf.set(new Uint8Array(1024), 2048)

  const entries = readTar(buf)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, longName)
  assert.equal(new TextDecoder().decode(entries[0]?.data ?? new Uint8Array()), 'hello')
})

test('ustar 的 prefix 字段要拼回完整路径', () => {
  const prefix = `jdk-21.0.5+11-jre/lib/security/policy${'/long-segment-0001'.repeat(5)}`
  const name = 'default_US_export_policy.jar'
  assert.ok(prefix.length + 1 + name.length > 100, '用 prefix 才放得下的路径')

  const buf = new Uint8Array(512 * 2 + 1024)
  buf.set(ustarBlock({ name, size: 4, prefix }), 0)
  buf.set(new TextEncoder().encode('data'), 512)
  buf.set(new Uint8Array(1024), 1024)

  const entries = readTar(buf)
  assert.equal(entries[0]?.name, `${prefix}/${name}`)
})

test('PAX 的 path 覆盖头字段', () => {
  const longName = `pax/${'y'.repeat(120)}.jar`
  const record = `${8 + longName.length + 1} path=${longName}\n`
  const recordBytes = new TextEncoder().encode(record)

  const buf = new Uint8Array(512 * 4 + 1024)
  buf.set(ustarBlock({ name: 'PaxHeader', size: recordBytes.length, typeflag: 'x' }), 0)
  buf.set(recordBytes, 512)
  buf.set(ustarBlock({ name: 'short.jar', size: 3 }), 1024)
  buf.set(new TextEncoder().encode('abc'), 1536)
  buf.set(new Uint8Array(1024), 2048)

  const entries = readTar(buf)
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, longName)
})

test('目录与符号链接', () => {
  const buf = new Uint8Array(512 * 2 + 1024)
  buf.set(ustarBlock({ name: 'jdk/bin/', size: 0, typeflag: '5' }), 0)
  buf.set(ustarBlock({ name: 'jdk/bin/java', size: 0, typeflag: '2' }), 512)
  buf.set(new Uint8Array(1024), 1024)

  const entries = readTar(buf)
  assert.equal(entries[0]?.type, 'dir')
  assert.equal(entries[0]?.name, 'jdk/bin', '目录的尾斜杠要去掉')
  assert.equal(entries[1]?.type, 'symlink')
  assert.equal(entries[1]?.data.length, 0)
})

test('magic 不对就报错，而不是产出乱码条目', () => {
  const buf = new Uint8Array(1024)
  buf.set(ustarBlock({ name: 'a.txt', size: 0, magic: 'NOTTAR' }), 0)
  assert.throws(() => readTar(buf), /不是 tar/)
})

test('声明的尺寸超过剩余字节时报截断', () => {
  const buf = new Uint8Array(512 + 100)
  buf.set(ustarBlock({ name: 'big.bin', size: 5000 }), 0)
  assert.throws(() => readTar(buf), /截断/)
})

test('gzip 包装（readTarGz）', () => {
  const inner = new Uint8Array(512 + 512 + 1024)
  inner.set(ustarBlock({ name: 'jdk/release', size: 2 }), 0)
  inner.set(new TextEncoder().encode('21'), 512)
  const gz = gzipSync(inner)
  const entries = readTarGz(gz)
  assert.equal(entries[0]?.name, 'jdk/release')
})

test('落盘：可执行位保留，slip 条目与符号链接被跳过', () => {
  withTemp((dir) => {
    const entries: TarEntry[] = [
      entry('jdk/bin/java', '#!/bin/sh\n', 0o755),
      entry('jdk/release', '21\n'),
      { name: 'jdk/lib/link', size: 0, mode: 0o777, type: 'symlink', data: new Uint8Array(0) },
      entry('../evil.txt', 'no'),
      entry('/absolute.txt', 'no'),
    ]
    const dest = join(dir, 'out')
    const r = writeTarEntries(entries, dest)

    assert.equal(r.files, 2)
    assert.equal(r.symlinks, 1)
    assert.ok(existsSync(join(dest, 'jdk', 'bin', 'java')))
    assert.ok(existsSync(join(dest, 'jdk', 'release')))
    assert.ok(!existsSync(join(dir, 'evil.txt')), 'tar slip 不允许逃出目标目录')
    assert.ok(!existsSync(join(dest, 'jdk', 'lib')))

    // Windows 的 chmod 只影响只读位，无法断言 0o755；断言“调过 chmod 没崩”即可
    assert.ok(statSync(join(dest, 'jdk', 'bin', 'java')).size > 0)
  })
})

test('和真 GNU tar 互通：tar 打包 → 读回 → 内容一致', () => {
  withTemp((dir) => {
    const src = join(dir, 'pkg')
    mkdirSync(src, { recursive: true })
    const files: [string, string][] = [
      ['a.txt', 'alpha'],
      ['deep/b/c/d.txt', 'delta'],
    ]
    for (const [rel, body] of files) {
      mkdirSync(join(src, rel, '..'), { recursive: true })
      writeFileSync(join(src, rel), body)
    }

    // GNU tar 把 `C://...` 当成远程主机（"Cannot connect to C:"），
    // 所以用 cwd + 相对路径。System32 的 bsdtar 与 Git Bash 的 GNU tar 都适用
    // 打包产物不能落在被打包的目录里，tar 会报 "file changed as we read it"
    execFileSync('tar', ['-czf', '../t.tar.gz', '.'], { cwd: src })

    const entries = readTarGz(new Uint8Array(readFileSync(join(dir, 't.tar.gz'))))
    const names = entries.filter((e) => e.type === 'file').map((e) => e.name.replace(/^\.\//, ''))
    assert.deepEqual(names.sort(), ['a.txt', 'deep/b/c/d.txt'])
    const a = entries.find((e) => e.name.endsWith('a.txt'))
    assert.equal(new TextDecoder().decode(a?.data ?? new Uint8Array()), 'alpha')
  })
})

test('空 tar（只有结束块）返回空数组', () => {
  assert.deepEqual(readTar(new Uint8Array(1024)), [])
})

test('条目里没有非文件内容时 writeTarEntries 不建目录', () => {
  withTemp((dir) => {
    const dest = join(dir, 'out')
    writeTarEntries([], dest)
    assert.ok(!existsSync(dest))
    assert.deepEqual(readdirSync(dir).length, 0)
  })
})
