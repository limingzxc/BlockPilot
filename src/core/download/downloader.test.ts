import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { downloadOne, verifyExisting } from './downloader.js'
import type { DownloadSource, DownloadTask } from './types.js'

const BODY = Buffer.from('hello blockpilot — this is a fake mod file')
const SHA1 = createHash('sha1').update(BODY).digest('hex')
const OTHER = Buffer.from('a completely different payload')

let baseUrl = ''
let server: ReturnType<typeof createServer>
let workDir = ''

before(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/good':
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(BODY)
        return
      case '/wrong':
        res.writeHead(200)
        res.end(OTHER)
        return
      case '/stall':
        // 头发完了就不动了：模拟半死不活的连接（没有 FIN，也没有 RST）
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(BODY.subarray(0, 4))
        return
      default:
        res.writeHead(404)
        res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
  workDir = mkdtempSync(join(tmpdir(), 'blockpilot-dl-'))
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

const direct: DownloadSource = { name: 'direct', credit: 'direct', rewrite: (url: URL) => url.toString() }

function task(path: string, name = 'x.jar'): DownloadTask {
  return {
    url: `${baseUrl}${path}`,
    fileName: name,
    destPath: join(workDir, name),
    expectedSize: BODY.byteLength,
    hashes: { sha1: SHA1 },
  }
}

const signal = new AbortController().signal

test('正常下载并校验哈希', async () => {
  const t = task('/good', 'ok.jar')
  const out = await downloadOne(t, [direct], signal)
  assert.equal(out.skipped, false)
  assert.equal(out.source, 'direct')
  assert.equal(out.bytes, BODY.byteLength)
  assert.deepEqual(readFileSync(t.destPath), BODY)
})

test('已存在且校验通过时跳过', async () => {
  const t = task('/good', 'ok.jar')
  const out = await downloadOne(t, [direct], signal)
  assert.equal(out.skipped, true)
  assert.equal(out.source, 'cache')
})

test('内容与哈希不符时拒绝落盘', async () => {
  const t = task('/wrong', 'bad.jar')
  // 先被大小检查挡下（30 != 44）；即使大小对得上，也会被哈希挡下
  await assert.rejects(() => downloadOne(t, [direct], signal), /size mismatch|hash mismatch/)
  assert.equal((await verifyExisting(t)).reason, 'missing')
})

test('一个源失败后降级到下一个源', async () => {
  const t = task('/good', 'fallback.jar')
  const broken: DownloadSource = {
    name: 'broken',
    credit: 'broken',
    rewrite: () => `${baseUrl}/404`,
  }
  const out = await downloadOne(t, [broken, direct], signal)
  assert.equal(out.source, 'direct')
  assert.equal(out.attempts.length, 2)
  assert.equal(out.attempts[0]?.ok, false)
  assert.equal(out.attempts[1]?.ok, true)
})

test('镜像返回错误内容会被哈希挡下，不会污染磁盘', async () => {
  const t = task('/good', 'poisoned.jar')
  const liar: DownloadSource = {
    name: 'liar',
    credit: 'liar',
    rewrite: () => `${baseUrl}/wrong`,
  }
  // liar 先上，返回错误内容 → 哈希不符 → 降级到 direct 成功
  const out = await downloadOne(t, [liar, direct], signal)
  assert.equal(out.source, 'direct')
  assert.deepEqual(readFileSync(t.destPath), BODY)
})

test('没有哈希的任务被拒绝下载', async () => {
  const t: DownloadTask = { ...task('/good', 'nohash.jar'), hashes: {} }
  await assert.rejects(() => downloadOne(t, [direct], signal), /没有 sha1\/sha512/)
})

test('已有文件哈希不符时会重新下载覆盖', async () => {
  const t = task('/good', 'stale.jar')
  writeFileSync(t.destPath, 'stale content')
  assert.equal((await verifyExisting(t)).reason, 'mismatch')
  const out = await downloadOne(t, [direct], signal)
  assert.equal(out.skipped, false)
  assert.deepEqual(readFileSync(t.destPath), BODY)
})

test('连接卡住时按空闲超时中止，不留半成品', async () => {
  const t = task('/stall', 'stall.jar')
  await assert.rejects(
    () => downloadOne(t, [direct], signal, { idleTimeoutMs: 500 }),
    /没有收到数据/,
  )
  assert.equal(existsSync(t.destPath), false)
  assert.equal(existsSync(`${t.destPath}.part`), false)
})
