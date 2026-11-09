/**
 * 系统凭据存储（可选）。
 *
 * 账号存档里的 `refresh_token` 是长期凭证：拿到它就能接管账号。ADR-0024 的
 * 现状是「明文写 0600 文件」——因为 Node 没有跨平台钥匙串 API，引原生依赖
 * 会让参考实现变成需要编译的工程。
 *
 * 这里用各平台自带的命令行工具做一个**可选**后端：
 * - Windows：DPAPI（PowerShell 调 `ProtectedData`），密文绑定当前用户
 * - macOS：`security`（登录钥匙串）
 * - Linux：`secret-tool`（Secret Service，GNOME/KDE 都有）
 *
 * 任何一步失败（工具不存在、被锁、无桌面会话）都返回 `null`，调用方继续用
 * 0600 文件。这不是「安全降级」，是「至少不比现在差」。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CredentialStore {
  readonly kind: 'dpapi' | 'keychain' | 'secret-service'
  get(account: string): string | null
  /** 返回 false 表示这次没存成，调用方应把凭证留在文件里 */
  set(account: string, secret: string): boolean
  delete(account: string): void
}

function run(file: string, args: readonly string[], input?: string): string {
  return execFileSync(file, [...args], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim()
}

function macKeychain(): CredentialStore {
  const service = 'blockpilot'
  return {
    kind: 'keychain',
    get: (account) => {
      try {
        const value = run('security', ['find-generic-password', '-a', account, '-s', service, '-w'])
        return value === '' ? null : value
      } catch {
        return null
      }
    },
    set: (account, secret) => {
      try {
        run('security', ['add-generic-password', '-U', '-a', account, '-s', service, '-w', secret])
        return true
      } catch {
        return false
      }
    },
    delete: (account) => {
      try {
        run('security', ['delete-generic-password', '-a', account, '-s', service])
      } catch {
        // 不存在就算了
      }
    },
  }
}

function linuxSecretService(): CredentialStore {
  return {
    kind: 'secret-service',
    get: (account) => {
      try {
        const value = run('secret-tool', ['lookup', 'service', 'blockpilot', 'account', account])
        return value === '' ? null : value
      } catch {
        return null
      }
    },
    set: (account, secret) => {
      try {
        run(
          'secret-tool',
          ['store', '--label=BlockPilot', 'service', 'blockpilot', 'account', account],
          secret,
        )
        return true
      } catch {
        return false
      }
    },
    delete: (account) => {
      try {
        run('secret-tool', ['clear', 'service', 'blockpilot', 'account', account])
      } catch {
        // 不存在就算了
      }
    },
  }
}

const DPAPI_ENCRYPT = `Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
[Convert]::ToBase64String($enc)`

const DPAPI_DECRYPT = `Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd().Trim()
$enc = [Convert]::FromBase64String($b64)
$bytes = [Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
[Text.Encoding]::UTF8.GetString($bytes)`

function windowsDpapi(dir: string): CredentialStore {
  const fileOf = (account: string): string => join(dir, `${account.replace(/[^\w-]/g, '_')}.dpapi`)
  return {
    kind: 'dpapi',
    get: (account) => {
      const file = fileOf(account)
      if (!existsSync(file)) return null
      try {
        const b64 = readFileSync(file, 'utf8')
        const value = run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', DPAPI_DECRYPT],
          b64,
        )
        return value === '' ? null : value
      } catch {
        return null
      }
    },
    set: (account, secret) => {
      try {
        mkdirSync(dir, { recursive: true })
        const b64 = run(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', DPAPI_ENCRYPT],
          secret,
        )
        if (b64 === '') return false
        writeFileSync(fileOf(account), `${b64}\n`, { mode: 0o600 })
        return true
      } catch {
        return false
      }
    },
    delete: (account) => {
      try {
        rmSync(fileOf(account), { force: true })
      } catch {
        // 不存在就算了
      }
    },
  }
}

/**
 * 探测并返回可用的后端。`authDir` 只给 Windows DPAPI 用（密文文件放这里）。
 * 返回 null 表示「没有可用的系统凭据存储」，调用方继续用文件。
 */
export function createCredentialStore(authDir: string): CredentialStore | null {
  if (process.platform === 'win32') {
    // PowerShell 在 Windows 上是系统组件；真跑不通时 set() 会返回 false
    return windowsDpapi(join(authDir, 'credentials'))
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('security', ['list-keychains'], { stdio: 'ignore', timeout: 5000 })
      return macKeychain()
    } catch {
      return null
    }
  }
  if (process.platform === 'linux') {
    try {
      execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 5000 })
      return linuxSecretService()
    } catch {
      return null
    }
  }
  return null
}
