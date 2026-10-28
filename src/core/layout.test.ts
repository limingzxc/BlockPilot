import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { LayoutError, resolveLayout } from './layout.js'

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'bp-layout-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('root 不存在：允许，安装时创建', () => {
  withTemp((dir) => {
    const layout = resolveLayout(join(dir, 'not-yet'), 'inst')
    assert.equal(layout.instanceId, 'inst')
  })
})

test('root 是目录：正常解析', () => {
  withTemp((dir) => {
    const layout = resolveLayout(dir)
    assert.equal(layout.gameDir, join(dir, 'instances', 'default'))
  })
})

test('root 是文件：抛 LayoutError，而不是让 mkdir 在第三步失败', () => {
  withTemp((dir) => {
    const file = join(dir, 'mc.txt')
    writeFileSync(file, 'x')
    assert.throws(
      () => resolveLayout(file),
      (err: unknown) => {
        assert.ok(err instanceof LayoutError)
        assert.match(err.message, /不是文件夹/)
        return true
      },
    )
  })
})
