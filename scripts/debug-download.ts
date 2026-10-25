/**
 * 调试用：对单个文件跑一遍所有源，打印每次尝试的真实结果。
 * 用法：npx tsx scripts/debug-download.ts <url> <sha1> [文件名]
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { downloadOne } from '../src/core/download/downloader.js'
import { chinaFirstSources } from '../src/core/download/sources.js'

const [url, sha1, name = 'probe.jar'] = process.argv.slice(2)
if (url === undefined || sha1 === undefined) {
  console.error('usage: tsx scripts/debug-download.ts <url> <sha1> [fileName]')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'bp-debug-'))
const outcome = await downloadOne(
  {
    url,
    fileName: name,
    destPath: join(dir, name),
    expectedSize: 0,
    hashes: { sha1 },
  },
  chinaFirstSources(),
  new AbortController().signal,
)

console.log('source   :', outcome.source)
console.log('bytes    :', outcome.bytes)
console.log('finalUrl :', outcome.finalUrl)
console.log('attempts :')
for (const a of outcome.attempts) {
  console.log(`  - ${a.source}: ${a.ok ? 'ok' : (a.error ?? 'failed')}`)
}
