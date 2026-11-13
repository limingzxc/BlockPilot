import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { detectHost } from './index.js'

test('root 推导出 <root>/java，java install 装的 JRE 才能被看见', async () => {
  const root = join('C:', 'data', 'BlockPilot')
  let seen: string | undefined
  const host = await detectHost({
    root,
    detect: async (opts) => {
      seen = opts.managedDir
      return { installs: [], rejected: [] }
    },
  })
  assert.equal(seen, join(root, 'java'))
  assert.deepEqual(host.javaMajors, [])
})

test('显式 managedJavaDir 优先于 root', async () => {
  let seen: string | undefined
  await detectHost({
    root: '/root',
    managedJavaDir: '/elsewhere/java',
    detect: async (opts) => {
      seen = opts.managedDir
      return { installs: [], rejected: [] }
    },
  })
  assert.equal(seen, '/elsewhere/java')
})
