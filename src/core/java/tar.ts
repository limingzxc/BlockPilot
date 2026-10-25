/**
 * 最小的 tar 读取器，只为解压 Adoptium 的 tar.gz 服务。
 *
 * 不引第三方依赖的理由和别处一样：这个包的目标是当参考实现，依赖越少越容易被读懂。
 * 而且我们只需要「按顺序读条目」，不需要随机访问、追加写、稀疏文件那一整套。
 *
 * 处理三种真实存在的格式：
 * - ustar（POSIX）：magic `ustar\0`，name 超长时走 345 字节的 prefix 字段
 * - GNU：magic `ustar `，超长路径用 typeflag `L` 的前导条目
 * - PAX：typeflag `x` 的前导条目，内容是 `长度 path=值\n` 的记录
 *
 * Adoptium 的包是 GNU tar 打的。哪个格式都没法只支持一种——
 * macOS 的 bsdtar 产出 PAX，老脚本产出 GNU 长名。
 */

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

export interface TarEntry {
  readonly name: string
  readonly size: number
  /** 已按八进制解析。目录是 0o755 之类，可执行文件带 0o111 位 */
  readonly mode: number
  readonly type: 'file' | 'dir' | 'symlink' | 'other'
  /** 只有 file 有内容 */
  readonly data: Uint8Array
}

const BLOCK = 512

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset
  const limit = offset + length
  while (end < limit && block[end] !== 0) end += 1
  return new TextDecoder().decode(block.subarray(offset, end))
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  // 八进制字段两侧可能是空格或 NUL，GNU 有时还会用 base-256 编码大值。
  // base-256 的标志是首字节高位为 1——JRE 里没有超过 8GB 的单文件，直接按八进制读
  let text = ''
  for (let i = 0; i < length; i += 1) {
    const b = block[offset + i]
    if (b === undefined || b === 0 || b === 0x20) continue
    text += String.fromCharCode(b)
  }
  if (text === '') return 0
  const n = parseInt(text, 8)
  return Number.isFinite(n) ? n : 0
}

function isZeroBlock(block: Uint8Array, offset: number): boolean {
  for (let i = 0; i < BLOCK; i += 1) {
    if (block[offset + i] !== 0) return false
  }
  return true
}

/** PAX 记录里抠 path：`25 path=target/long/name\n` */
function paxPath(data: Uint8Array): string | null {
  const text = new TextDecoder().decode(data)
  for (const record of text.split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(record)
    const p = m?.[1]
    if (p !== undefined) return p
  }
  return null
}

export function readTar(buffer: Uint8Array): readonly TarEntry[] {
  const entries: TarEntry[] = []
  const decoder = new TextDecoder()

  // GNU `L` 与 PAX `x` 只对**紧随其后**的那一条生效，读完就清掉
  let pendingName: string | null = null

  let offset = 0
  while (offset + BLOCK <= buffer.length) {
    if (isZeroBlock(buffer, offset)) break

    const block = buffer.subarray(offset, offset + BLOCK)
    const magic = decoder.decode(block.subarray(257, 263))
    if (!magic.startsWith('ustar')) {
      throw new Error(`不是 tar：偏移 ${offset} 处的 magic 是 ${JSON.stringify(magic)}`)
    }

    const rawName = readString(block, 0, 100)
    const prefix = readString(block, 345, 155)
    const size = readOctal(block, 124, 12)
    const mode = readOctal(block, 100, 8)
    const typeByte = block[156]
    const typeflag = String.fromCharCode(typeByte === undefined ? 0x30 : typeByte)

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > buffer.length) {
      throw new Error(`tar 被截断：条目 ${rawName} 声称有 ${size} 字节，但只剩 ${buffer.length - dataStart}`)
    }
    const data = buffer.subarray(dataStart, dataEnd)
    offset = dataEnd + (BLOCK - (size % BLOCK)) % BLOCK

    if (typeflag === 'L') {
      pendingName = readString(data, 0, data.length)
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const p = paxPath(data)
      if (p !== null) pendingName = p
      continue
    }

    const raw = pendingName ?? (prefix !== '' ? `${prefix}/${rawName}` : rawName)
    pendingName = null

    let type: TarEntry['type'] = 'other'
    if (typeflag === '0' || typeflag === '\0') type = 'file'
    else if (typeflag === '5') type = 'dir'
    else if (typeflag === '2' || typeflag === '1') type = 'symlink'

    // 目录条目常带尾斜杠，调用方按 split('/') 建路径时会产生空段，去掉
    const name = type === 'dir' ? raw.replace(/\/$/, '') : raw

    entries.push({
      name,
      size,
      mode,
      type,
      ...(type === 'file' ? { data } : { data: new Uint8Array(0) }),
    })
  }

  return entries
}

/** 解开 gzip 再读条目。Adoptium 的 linux/mac 构建都是 tar.gz。 */
export function readTarGz(buffer: Uint8Array): readonly TarEntry[] {
  return readTar(gunzipSync(buffer))
}

/**
 * 把条目写到磁盘。
 *
 * 可执行位照搬 tar 里的 mode——`bin/java` 没有执行位，装完就是跑不起来。
 * Windows 的 chmod 只影响只读位，包在 try 里即可。
 *
 * 符号链接跳过：JRE 的关键路径（bin/java、lib/modules）都是真实文件，
 * 链接只是锦上添花。跳过比伪造一个跨平台安全的链接简单可靠。
 *
 * `..` 与绝对路径一律跳过——tar slip 和 zip slip 是同一个坑。
 */
export function writeTarEntries(
  entries: readonly TarEntry[],
  destDir: string,
): { files: number; symlinks: number } {
  let files = 0
  let symlinks = 0
  for (const entry of entries) {
    if (entry.name.startsWith('/') || entry.name.includes('..')) continue
    if (entry.type === 'symlink') {
      symlinks += 1
      continue
    }
    if (entry.type !== 'file') continue

    const out = join(destDir, ...entry.name.split('/'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, entry.data)
    if ((entry.mode & 0o111) !== 0) {
      try {
        chmodSync(out, entry.mode & 0o777)
      } catch {
        // Windows 上没有可执行位的概念，忽略
      }
    }
    files += 1
  }
  return { files, symlinks }
}
