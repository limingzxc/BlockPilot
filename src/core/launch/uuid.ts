import { createHash } from 'node:crypto'

/**
 * 离线模式的 UUID。
 *
 * 原版 `UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8))`：
 * MD5 → 版本位改成 3、变体位改成 RFC 4122。全零 UUID 也能启动单人，
 * 但联机到离线服务器时，服务端按这个名字算出的是**另一个** UUID，
 * 白名单、玩家数据、权限组都对不上。
 *
 * 返回带连字符的标准形式；调用方按 `--uuid` 的要求去掉连字符。
 */
export function offlineUuid(name: string): string {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  // version 3（基于名字的 MD5）
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x30
  // RFC 4122 variant
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** `--uuid` 要的 32 位十六进制形式。 */
export function offlineUuidHex(name: string): string {
  return offlineUuid(name).replace(/-/g, '')
}
