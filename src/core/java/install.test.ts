/**
 * `java install` 的「已装则跳过」判断。
 *
 * 这条逻辑曾经写成 `major >= 目标`，于是 `java install 17` 在只装了 21 的机器上
 * 直接回「已存在 Java 21」并退出 0——用户点名要 17，拿到的是 21。
 * 靠真机跑才发现，所以这里用注入的 probe/fetchBinary 把它钉住。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { collect } from '../events/operation.js'
import { resolveLayout } from '../layout.js'
import { absent } from '../probe.js'
import { createJavaInstall, findJavaExecutables } from './install.js'
import type { JavaInstall } from './types.js'

const EXE = process.platform === 'win32' ? 'java.exe' : 'java'

function fakeJdk(root: string, dirName: string): string {
  const path = join(root, 'java', dirName, 'bin', EXE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, 'fake')
  return path
}

function probed(path: string, major: number): JavaInstall {
  return { path, version: `${major}.0.1`, major, source: 'managed' }
}

test('macOS 布局 <name>/Contents/Home/bin/java 也能找到', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-java-mac-'))
  try {
    const path = join(dir, 'java', 'temurin-21.jdk', 'Contents', 'Home', 'bin', EXE)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'fake')
    assert.deepEqual(findJavaExecutables(join(dir, 'java')), [path])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同大版本已装：直接跳过，不联网', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-java-skip-'))
  try {
    const path = fakeJdk(dir, 'jdk-17.0.21+9-jre')
    const r = await collect(
      createJavaInstall({
        layout: resolveLayout(dir, 'default'),
        major: 17,
        probe: async (p) => (p === path ? probed(p, 17) : null),
        fetchBinary: async () => {
          throw new Error('不该联网：同版本已经在了')
        },
      }),
    )
    assert.equal(r.skipped, true)
    assert.equal(r.bytes, 0)
    assert.equal(r.java.major, 17)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只有更高的版本时不跳过（要 17、装了 21 → 仍去下载 17）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-java-higher-'))
  try {
    const path = fakeJdk(dir, 'jdk-21.0.12.1+1-jre')
    // fetchBinary 返回 absent → 走 JAVA_NOT_FOUND，说明它**没有**在「已存在 21」处短路
    await assert.rejects(
      () =>
        collect(
          createJavaInstall({
            layout: resolveLayout(dir, 'default'),
            major: 17,
            probe: async (p) => (p === path ? probed(p, 21) : null),
            fetchBinary: async () => absent('test: 没有这个构建'),
          }),
        ),
      (err: Error & { code?: string }) => {
        assert.equal(err.code, 'JAVA_NOT_FOUND')
        return true
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只有更低的版本时同样不跳过（要 21、装了 17）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-java-lower-'))
  try {
    const path = fakeJdk(dir, 'jdk-17.0.21+9-jre')
    await assert.rejects(
      () =>
        collect(
          createJavaInstall({
            layout: resolveLayout(dir, 'default'),
            major: 21,
            probe: async (p) => (p === path ? probed(p, 17) : null),
            fetchBinary: async () => absent('test: 没有这个构建'),
          }),
        ),
      (err: Error & { code?: string }) => err.code === 'JAVA_NOT_FOUND',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
