import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { CredentialStore } from './credentials.js'
import { type AuthAccount, authError } from './types.js'

/**
 * 账号存档。
 *
 * 放 `<root>/auth/accounts.json`，与实例、libraries 同根——
 * 一个数据根目录就是「用户只选一次」的全部含义（ADR-0008）。
 *
 * 明文存令牌，和所有第三方启动器一样。原因不是偷懒：Node 没有跨平台的
 * 系统钥匙串接口，引一个原生依赖会让「参考实现」变成「需要编译的工程」。
 * 代价写进 ADR-0024：能读到这个文件的人就能接管账号，所以文件权限收到 0600
 * （Windows 上是尽力而为）。
 */
const FILE_NAME = 'accounts.json'
const SCHEMA_VERSION = 1

export interface AuthStore {
  readonly accounts: readonly AuthAccount[]
  /** 上次登录/使用的账号 uuid，`launch` 默认用它 */
  readonly active?: string
}

export function authStorePath(root: string): string {
  return join(root, 'auth', FILE_NAME)
}

/** 只保留形状完整的条目：一个字段缺失的账号在启动时才会炸，太晚。 */
function isValidAccount(v: unknown): v is AuthAccount {
  if (v === null || typeof v !== 'object') return false
  const a = v as Record<string, unknown>
  return (
    typeof a.uuid === 'string' &&
    /^[0-9a-f]{32}$/i.test(a.uuid) &&
    typeof a.name === 'string' &&
    a.name !== '' &&
    typeof a.accessToken === 'string' &&
    typeof a.expiresAt === 'number' &&
    typeof a.obtainedAt === 'number'
  )
}

export function loadStore(path: string, credentials: CredentialStore | null = null): AuthStore {
  if (!existsSync(path)) return { accounts: [] }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw authError('AUTH_STORE_CORRUPT', `读不了账号存档：${String(err)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw authError(
      'AUTH_STORE_CORRUPT',
      `账号存档不是合法 JSON：${path}`,
      '删掉这个文件后重新 login；里面是明文令牌，损坏时没有修复价值',
    )
  }

  const obj = parsed as { accounts?: unknown; active?: unknown } | null
  const list = Array.isArray(obj?.accounts) ? obj.accounts : []
  const accounts = list.filter(isValidAccount).map((account) => {
    if (credentials === null) return account
    const refreshToken = credentials.get(account.uuid)
    return refreshToken === null ? account : { ...account, refreshToken }
  })
  const active = typeof obj?.active === 'string' ? obj.active : undefined
  return { accounts, ...(active === undefined ? {} : { active }) }
}

/**
 * 写入存档。
 *
 * 先写临时文件再 rename：中途被打断（Ctrl+C、断电）时，旧文件仍然完整。
 * 直接覆写的话，一次中断就会留下半截 JSON，下次启动报「存档损坏」——
 * 而用户什么都没做错。
 */
export function saveStore(
  path: string,
  store: AuthStore,
  credentials: CredentialStore | null = null,
): void {
  mkdirSync(dirname(path), { recursive: true })
  // 有系统凭据存储时，refresh_token 不落盘：文件里只留短期 token 与元数据。
  // set() 失败（钥匙串被锁/工具缺失）就保持原样，不制造「以为存了其实没存」。
  const accounts = store.accounts.map((account) => {
    if (credentials === null || account.refreshToken === undefined) return account
    if (!credentials.set(account.uuid, account.refreshToken)) return account
    const { refreshToken: _omit, ...rest } = account
    return rest
  })
  const payload = {
    version: SCHEMA_VERSION,
    active: store.active ?? null,
    accounts,
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    // Windows 上 chmod 只影响只读位，忽略
  }
  renameSync(tmp, path)
}

/** 新增或按 uuid 覆盖，并把它设为当前账号。 */
export function upsertAccount(
  path: string,
  account: AuthAccount,
  credentials: CredentialStore | null = null,
): AuthStore {
  const store = loadStore(path, credentials)
  const others = store.accounts.filter((a) => a.uuid !== account.uuid)
  const next: AuthStore = { accounts: [...others, account], active: account.uuid }
  saveStore(path, next, credentials)
  return next
}

/**
 * 按 uuid 或名字挑账号。
 *
 * 名字大小写不敏感：玩家记得的是「Steve」而不是自己 uuid 的前八位。
 * 重名时以 uuid 精确匹配优先，名字匹配取第一个——Minecraft 的玩家名全局唯一，
 * 重名只可能来自改名后的旧存档。
 */
export function pickAccount(store: AuthStore, selector?: string): AuthAccount | null {
  const want = selector?.trim()
  if (want === undefined || want === '') {
    const active = store.accounts.find((a) => a.uuid === store.active)
    return active ?? store.accounts[0] ?? null
  }

  const normalized = want.replace(/-/g, '').toLowerCase()
  const byUuid = store.accounts.find((a) => a.uuid.toLowerCase() === normalized)
  if (byUuid !== undefined) return byUuid
  return store.accounts.find((a) => a.name.toLowerCase() === want.toLowerCase()) ?? null
}

/** 删一个账号。返回是否真的删掉了。 */
export function removeAccount(
  path: string,
  selector: string,
  credentials: CredentialStore | null = null,
): boolean {
  const store = loadStore(path, credentials)
  const target = pickAccount(store, selector)
  if (target === null) return false
  const accounts = store.accounts.filter((a) => a.uuid !== target.uuid)
  const active = store.active === target.uuid ? accounts[0]?.uuid : store.active
  credentials?.delete(target.uuid)
  saveStore(path, { accounts, ...(active === undefined ? {} : { active }) }, credentials)
  return true
}
