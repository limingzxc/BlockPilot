/**
 * 下载真实 E2E 夹具里可以自动获取的小件。
 *
 * `fixtures/` 被 gitignore，换机器/清目录后需要重建。这个脚本只拉：
 *   - FO 6.5.0 mrpack（E2E-101/102/106/402/403）
 *   - sodium 1.20.1（E2E-303 的对照 jar）
 *
 * `fixtures/mcroot` 的其余内容（原版、assets、Java、FO 实例）需要真实下载，
 * 按 docs/testing/real-tests.md 的「重建真实夹具」一节执行。脚本刻意不默认拉
 * 788 MB assets，也不启动游戏。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** 固定版本，避免「latest」把测试变成随上游漂移的浮动目标。 */
const FIXTURES = [
  {
    url: 'https://api.modrinth.com/v2/version/N276l2ON',
    projectId: '1KVo5zza',
    path: join(ROOT, 'fixtures', 'fo-6.5.0.mrpack'),
  },
  {
    url: 'https://api.modrinth.com/v2/version/OihdIimA',
    projectId: 'AANobbMI',
    path: join(ROOT, 'fixtures', 'mcroot', 'instances', 'good', 'mods', 'sodium-fabric-0.5.13+mc1.20.1.jar'),
  },
]

function sha1(buf) {
  return createHash('sha1').update(buf).digest('hex')
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'blockpilot-fixtures/1' } })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

async function ensure(file) {
  const meta = await fetchJson(file.url)
  if (meta.project_id !== file.projectId) {
    throw new Error(`${file.url} 返回的 project_id=${meta.project_id}，期望 ${file.projectId}`)
  }
  const entry = meta.files?.find((f) => f.primary) ?? meta.files?.[0]
  if (entry === undefined) throw new Error(`${file.url} 没有文件`)
  const expected = entry.hashes?.sha1
  if (typeof expected !== 'string' || expected === '') {
    throw new Error(`${file.url} 没有 sha1，拒绝下载`)
  }

  if (existsSync(file.path)) {
    const current = sha1(readFileSync(file.path))
    if (current === expected) {
      console.log(`skip   ${file.path}  (${entry.size} B, sha1 ok)`)
      return
    }
    console.log(`stale  ${file.path}  (sha1 不符，重新下载)`)
  }

  const res = await fetch(entry.url, { headers: { 'User-Agent': 'blockpilot-fixtures/1' } })
  if (!res.ok) throw new Error(`${entry.url} -> HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const actual = sha1(body)
  if (actual !== expected) {
    throw new Error(`sha1 不符：${file.path} 期望 ${expected}，实际 ${actual}`)
  }
  mkdirSync(dirname(file.path), { recursive: true })
  writeFileSync(file.path, body)
  console.log(`wrote  ${file.path}  (${body.length} B)`)
}

for (const fixture of FIXTURES) {
  await ensure(fixture)
}

console.log(`
小件就绪。完整 mcroot 还需要真实下载（见 docs/testing/real-tests.md）：

  npm run build
  node dist/cli/index.js deploy fixtures/fo-6.5.0.mrpack --root fixtures/mcroot --instance fo
  node dist/cli/index.js assets 1.21.1 --root fixtures/mcroot
  node dist/cli/index.js java install 21 --root fixtures/mcroot

然后：

  npm run e2e -- --tier 0,1,2
  npm run e2e -- --tier 3 --only E2E-301
`)
