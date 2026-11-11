/**
 * bin 链接烟测：通过符号链接启动 dist/cli/index.js。
 *
 * `npm link` / 全局安装时，`bin` 是指向真实文件的符号链接：argv[1] 是链接路径，
 * 而 ESM 的 import.meta.url 已经是 realpath。入口守卫以前直接比较两者，
 * 在 Linux/macOS 上永远不相等——CLI 静默退出 0。Windows 的 .cmd shim 传真实
 * 路径，开发机和 Windows CI 都发现不了，所以这条必须在符号链接上跑。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const entry = join(root, 'dist', 'cli', 'index.js')
if (!existsSync(entry)) {
  console.error('[bin] 找不到 dist/cli/index.js；先 npm run build')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'bp-bin-'))
const link = join(dir, 'blockpilot')
try {
  try {
    symlinkSync(entry, link, 'file')
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      console.warn('[bin] SKIP: 当前 Windows 会话没有创建符号链接的权限（Ubuntu CI 会覆盖这条）')
      process.exit(0)
    }
    throw err
  }

  const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) {
    console.error(`[bin] 通过符号链接调用退出码 ${String(r.status)}`)
    console.error(r.stderr)
    process.exit(1)
  }
  if (!r.stdout.includes('BlockPilot')) {
    console.error('[bin] --help 没有输出：入口守卫在符号链接下没有启动 main()')
    console.error(r.stdout)
    console.error(r.stderr)
    process.exit(1)
  }
  console.log('[bin] 符号链接入口可用')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
