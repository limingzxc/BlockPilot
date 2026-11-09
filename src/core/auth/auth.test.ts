import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { exchangeMsaForAccount, isExpired, loginWithMicrosoft, refreshAccount } from './chain.js'
import type { HttpClient } from './http.js'
import { createLogin, resolveAccount } from './index.js'
import { pollForToken, requestDeviceCode } from './msa.js'
import { authStorePath, loadStore, upsertAccount } from './store.js'
import { type AuthAccount, AuthError } from './types.js'

interface Call {
  readonly method: 'form' | 'json' | 'get'
  readonly url: string
  readonly payload: unknown
}

type Handler = (req: Call) => { status: number; body: unknown }
type RecordingHttp = HttpClient & { readonly calls: Call[] }

function httpRecorder(handler: Handler): RecordingHttp {
  const calls: Call[] = []
  const record = (
    method: Call['method'],
    url: string,
    payload: unknown,
  ): { status: number; body: unknown } => {
    const call: Call = { method, url, payload }
    calls.push(call)
    return handler(call)
  }
  return {
    calls,
    postForm: async (url, fields) => record('form', url, fields),
    postJson: async (url, json) => record('json', url, json),
    getJson: async (url) => record('get', url, undefined),
  }
}

const DEVICE = {
  device_code: 'DC-secret',
  user_code: 'AB12-CD34',
  verification_uri: 'https://microsoft.com/link',
  expires_in: 900,
  interval: 1,
}

const PROFILE = { id: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch' }

/** 一条一切正常的链。每个用例覆盖自己要改的那一段。 */
function happyPath(
  overrides: Partial<Record<string, () => { status: number; body: unknown }>> = {},
): Handler {
  return (req) => {
    const key = Object.keys(overrides).find((k) => req.url.includes(k))
    if (key !== undefined) {
      const fn = overrides[key]
      if (fn !== undefined) return fn()
    }
    if (req.url.endsWith('/devicecode')) return { status: 200, body: DEVICE }
    if (req.url.endsWith('/token')) {
      return {
        status: 200,
        body: { access_token: 'msa-at', refresh_token: 'msa-rt-1', expires_in: 3600 },
      }
    }
    if (req.url.includes('user.auth.xboxlive.com')) {
      return {
        status: 200,
        body: { Token: 'xbl-token', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } },
      }
    }
    if (req.url.includes('xsts.auth.xboxlive.com')) {
      return {
        status: 200,
        body: {
          Token: 'xsts-token',
          DisplayClaims: { xui: [{ uhs: 'uhs-1', xid: '2535410000000000' }] },
        },
      }
    }
    if (req.url.includes('login_with_xbox')) {
      return { status: 200, body: { access_token: 'mc-at', expires_in: 86_400 } }
    }
    if (req.url.includes('entitlements')) {
      return {
        status: 200,
        body: { items: [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] },
      }
    }
    if (req.url.includes('/minecraft/profile')) return { status: 200, body: PROFILE }
    return { status: 404, body: null }
  }
}

const noSleep = async (): Promise<void> => {}

function account(now: number): AuthAccount {
  return {
    uuid: '069a79f444e94726a5befca90e38aaf5',
    name: 'Notch',
    accessToken: 'mc-at',
    expiresAt: now + 3_600_000,
    xuid: '2535410000000000',
    refreshToken: 'rt',
    clientId: 'client-1',
    obtainedAt: now,
    userType: 'msa',
  }
}

// ---------- 设备码 ----------

test('设备码：字段映射正确，deviceCode 与 userCode 不混淆', async () => {
  const http = httpRecorder(happyPath())
  const code = await requestDeviceCode({ clientId: 'client-1', http, now: () => 1000 })

  assert.equal(code.deviceCode, 'DC-secret')
  assert.equal(code.userCode, 'AB12-CD34')
  assert.equal(code.verificationUri, 'https://microsoft.com/link')
  assert.equal(code.intervalMs, 1000)
  assert.equal(code.expiresAt, 1000 + 900_000)

  const sent = http.calls[0]?.payload as Record<string, string>
  assert.equal(sent['client_id'], 'client-1')
  // offline_access 缺了就拿不到 refresh_token，用户每次启动都要重新授权
  assert.match(sent['scope'] ?? '', /XboxLive\.signin/)
  assert.match(sent['scope'] ?? '', /offline_access/)
})

test('设备码：没配 client id 时直接失败，不发请求', async () => {
  const http = httpRecorder(happyPath())
  await assert.rejects(
    () => requestDeviceCode({ clientId: '', http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'AUTH_NO_CLIENT_ID')
      return true
    },
  )
  assert.equal(http.calls.length, 0)
})

// ---------- 轮询 ----------

test('轮询：authorization_pending 继续等，成功后返回令牌', async () => {
  let polls = 0
  const http = httpRecorder((req) => {
    if (req.url.endsWith('/token')) {
      polls += 1
      if (polls <= 2) return { status: 400, body: { error: 'authorization_pending' } }
      return { status: 200, body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600 } }
    }
    return { status: 404, body: null }
  })
  const waits: number[] = []
  const code = {
    deviceCode: 'DC',
    userCode: 'U',
    verificationUri: 'v',
    expiresAt: 1_000_000,
    intervalMs: 1000,
  }
  const token = await pollForToken({
    clientId: 'c',
    code,
    http,
    now: () => 0,
    sleepFn: async (ms) => {
      waits.push(ms)
    },
  })
  assert.equal(token.accessToken, 'at')
  assert.equal(token.refreshToken, 'rt')
  assert.equal(token.expiresAt, 3_600_000)
  assert.deepEqual(waits, [1000, 1000])
})

test('轮询：slow_down 把间隔加 5 秒（RFC 8628 的要求）', async () => {
  let polls = 0
  const http = httpRecorder((req) => {
    if (req.url.endsWith('/token')) {
      polls += 1
      if (polls === 1) return { status: 400, body: { error: 'slow_down' } }
      return { status: 200, body: { access_token: 'at', refresh_token: 'rt' } }
    }
    return { status: 404, body: null }
  })
  const waits: number[] = []
  await pollForToken({
    clientId: 'c',
    code: {
      deviceCode: 'DC',
      userCode: 'U',
      verificationUri: 'v',
      expiresAt: 1e9,
      intervalMs: 1000,
    },
    http,
    now: () => 0,
    sleepFn: async (ms) => {
      waits.push(ms)
    },
  })
  assert.deepEqual(waits, [6000])
})

test('轮询：用户拒绝 → AUTH_DENIED，不是「网络错误」', async () => {
  const http = httpRecorder(() => ({ status: 400, body: { error: 'authorization_declined' } }))
  await assert.rejects(
    () =>
      pollForToken({
        clientId: 'c',
        code: {
          deviceCode: 'DC',
          userCode: 'U',
          verificationUri: 'v',
          expiresAt: 1e9,
          intervalMs: 1,
        },
        http,
        now: () => 0,
        sleepFn: noSleep,
      }),
    (err: unknown) => err instanceof AuthError && err.code === 'AUTH_DENIED',
  )
})

test('轮询：设备码过期后不再请求，直接报 AUTH_EXPIRED', async () => {
  const http = httpRecorder(() => ({ status: 400, body: { error: 'authorization_pending' } }))
  let clock = 0
  await assert.rejects(
    () =>
      pollForToken({
        clientId: 'c',
        code: {
          deviceCode: 'DC',
          userCode: 'U',
          verificationUri: 'v',
          expiresAt: 5000,
          intervalMs: 1000,
        },
        http,
        now: () => clock,
        sleepFn: async () => {
          clock += 3000
        },
      }),
    (err: unknown) => err instanceof AuthError && err.code === 'AUTH_EXPIRED',
  )
})

// ---------- 整条链 ----------

test('完整链：uuid 去掉连字符，xuid 从 XSTS 的 xid 取出', async () => {
  const http = httpRecorder(happyPath())
  const acc = await loginWithMicrosoft({
    clientId: 'client-1',
    http,
    now: () => 1000,
    sleepFn: noSleep,
  })

  assert.equal(acc.uuid, '069a79f444e94726a5befca90e38aaf5')
  assert.equal(acc.name, 'Notch')
  assert.equal(acc.xuid, '2535410000000000')
  assert.equal(acc.accessToken, 'mc-at')
  assert.equal(acc.refreshToken, 'msa-rt-1')
  assert.equal(acc.clientId, 'client-1')
  assert.equal(acc.userType, 'msa')

  // 五个端点一个不少，且顺序是 MSA → XBL → XSTS → MC → 档案
  const urls = http.calls.map((c) => c.url)
  assert.equal(urls.filter((u) => u.includes('devicecode')).length, 1)
  assert.equal(urls.filter((u) => u.includes('user.auth.xboxlive.com')).length, 1)
  assert.equal(urls.filter((u) => u.includes('xsts.auth')).length, 1)
  assert.equal(urls.filter((u) => u.includes('login_with_xbox')).length, 1)
  assert.equal(urls.filter((u) => u.includes('/minecraft/profile')).length, 1)

  /**
   * 三个上游请求**整份**比对，不是挑字段。
   *
   * 挑字段的代价真实发生过：`Properties.AuthMethod` 缺失时 XBL 返回 400 空体，
   * 看起来像令牌失效，23 个测试全绿。整份 deepEqual 让「少一个字段」直接变成红用例——
   * 加字段时 diff 也会指出改了哪一处契约。
   */
  const xbl = http.calls.find((c) => c.url.includes('user.auth.xboxlive.com'))
  assert.deepEqual(xbl?.payload, {
    Properties: { AuthMethod: 'RPS', RpsTicket: 'd=msa-at', SiteName: 'user.auth.xboxlive.com' },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  })

  const xsts = http.calls.find((c) => c.url.includes('xsts.auth'))
  assert.deepEqual(xsts?.payload, {
    Properties: { SandboxId: 'RETAIL', UserTokens: ['xbl-token'] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  })

  const mc = http.calls.find((c) => c.url.includes('login_with_xbox'))
  assert.deepEqual(mc?.payload, { identityToken: 'XBL3.0 x=uhs-1;xsts-token' })
})

test('XBL 401 → 说「令牌被拒」，而不是让用户去查请求形状', async () => {
  const http = httpRecorder(
    happyPath({ 'user.auth.xboxlive.com': () => ({ status: 401, body: null }) }),
  )
  await assert.rejects(
    () => exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'XBL_FAILED')
      assert.match(err.message, /401/)
      assert.match(err.hint ?? '', /重新 login/)
      return true
    },
  )
})

test('MC 登录说「Invalid app registration」→ 白名单问题，别让用户重试', async () => {
  const http = httpRecorder(
    happyPath({
      login_with_xbox: () => ({
        status: 401,
        body: {
          path: '/authentication/login_with_xbox',
          errorMessage:
            'Invalid app registration, see https://aka.ms/AppRegInfo for more information',
        },
      }),
    }),
  )
  await assert.rejects(
    () => exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'MC_APP_NOT_ALLOWLISTED')
      assert.match(err.hint ?? '', /mce-reviewappid/)
      assert.doesNotMatch(err.hint ?? '', /重试一次/)
      return true
    },
  )
})

test('XSTS 2148916233 → 没有 Xbox 档案，hint 指向 xbox.com', async () => {
  const http = httpRecorder(
    happyPath({
      'xsts.auth': () => ({ status: 401, body: { XErr: 2148916233, Message: 'no xbox account' } }),
    }),
  )
  await assert.rejects(
    () => exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'XSTS_NO_XBOX_ACCOUNT')
      assert.match(err.hint ?? '', /xbox\.com/)
      return true
    },
  )
})

test('XSTS 2148916238 → 未成年账号，hint 指向家庭组', async () => {
  const http = httpRecorder(
    happyPath({ 'xsts.auth': () => ({ status: 401, body: { XErr: 2148916238 } }) }),
  )
  let captured: AuthError | undefined
  try {
    await exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http })
  } catch (err) {
    assert.ok(err instanceof AuthError)
    captured = err
  }
  assert.equal(captured?.code, 'XSTS_CHILD_ACCOUNT')
  assert.match(captured?.hint ?? '', /family/)
})

test('所有权为空清单 → MC_NO_GAME_OWNERSHIP（不是「没档案」）', async () => {
  const http = httpRecorder(
    happyPath({ entitlements: () => ({ status: 200, body: { items: [] } }) }),
  )
  await assert.rejects(
    () => exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'MC_NO_GAME_OWNERSHIP')
      // 顺序保证：没买游戏时不该走到档案查询
      return true
    },
  )
  assert.equal(
    http.calls.some((c) => c.url.includes('/minecraft/profile')),
    false,
  )
})

test('所有权接口故障（500）不拦登录——附加校验不该变成门槛', async () => {
  const http = httpRecorder(happyPath({ entitlements: () => ({ status: 500, body: null }) }))
  const acc = await exchangeMsaForAccount(
    { accessToken: 'a', refreshToken: 'r', expiresAt: 0 },
    { http },
  )
  assert.equal(acc.name, 'Notch')
})

test('档案 404 → MC_NO_PROFILE，hint 区分「只买了基岩版」', async () => {
  const http = httpRecorder(
    happyPath({ '/minecraft/profile': () => ({ status: 404, body: null }) }),
  )
  await assert.rejects(
    () => exchangeMsaForAccount({ accessToken: 'a', refreshToken: 'r', expiresAt: 0 }, { http }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'MC_NO_PROFILE')
      assert.match(err.hint ?? '', /基岩版/)
      return true
    },
  )
})

test('刷新：换到新的 refresh_token 并保留 clientId', async () => {
  const http = httpRecorder(
    happyPath({
      '/token': () => ({
        status: 200,
        body: { access_token: 'msa-at-2', refresh_token: 'rt-2', expires_in: 3600 },
      }),
    }),
  )
  const acc = await refreshAccount(account(0), { http, now: () => 10_000 })
  assert.equal(acc.refreshToken, 'rt-2', '刷新令牌是一次性的，必须写回新的')
  assert.equal(acc.clientId, 'client-1')
  assert.equal(acc.accessToken, 'mc-at')
  assert.equal(acc.obtainedAt, 10_000)

  const sent = http.calls[0]?.payload as Record<string, string>
  assert.equal(sent['grant_type'], 'refresh_token')
  assert.equal(sent['refresh_token'], 'rt')
})

test('刷新：没有 refresh_token 的旧账号给出明确结论', async () => {
  const legacy: AuthAccount = { ...account(0), refreshToken: undefined, clientId: undefined }
  await assert.rejects(
    () => refreshAccount(legacy, { http: httpRecorder(happyPath()) }),
    (err: unknown) => {
      assert.ok(err instanceof AuthError)
      assert.equal(err.code, 'AUTH_REFRESH_UNAVAILABLE')
      return true
    },
  )
})

test('isExpired 留 60 秒余量：到期前一分钟就算过期', () => {
  const acc = { ...account(0), expiresAt: 100_000 }
  assert.equal(isExpired(acc, 39_000), false) // 还有 61 秒
  assert.equal(isExpired(acc, 40_000), true) // 只剩 60 秒
})

// ---------- Operation 与选号 ----------

test('createLogin：设备码先成为事件，再出结果并写档', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-op-'))
  try {
    const storePath = authStorePath(dir)
    const http = httpRecorder(happyPath())
    const events: string[] = []
    let account: AuthAccount | undefined

    for await (const ev of createLogin({
      clientId: 'client-1',
      storePath,
      http,
      sleepFn: noSleep,
      now: () => 1000,
    }).run(new AbortController().signal)) {
      if (ev.type === 'log' && ev.code === 'auth.device_code') {
        const data = ev.data as {
          userCode: string
          verificationUri: string
          expiresInSec: number
          expiresAt: number
        }
        assert.equal(data.userCode, 'AB12-CD34')
        assert.equal(data.verificationUri, 'https://microsoft.com/link')
        assert.equal(data.expiresInSec, 900)
        // 绝对时刻，调用方据此说「有效至 12:57」，不用自己加 15 分钟
        assert.equal(data.expiresAt, 1000 + 900_000)
        events.push('device_code')
      }
      if (ev.type === 'result') {
        account = ev.value
        events.push('result')
      }
    }

    assert.deepEqual(events, ['device_code', 'result'])
    assert.equal(account?.name, 'Notch')

    const stored = loadStore(storePath)
    assert.equal(stored.accounts.length, 1)
    assert.equal(stored.active, account?.uuid)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createLogin：--timeout 到点报 AUTH_TIMEOUT，与「设备码过期」分开', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-timeout-'))
  try {
    // 永远 pending：不设超时的话，这个用例会一直轮询下去
    const http = httpRecorder(
      happyPath({ '/token': () => ({ status: 400, body: { error: 'authorization_pending' } }) }),
    )
    const failures: Array<{ code: string; message: string }> = []

    for await (const ev of createLogin({
      clientId: 'client-1',
      storePath: authStorePath(dir),
      http,
      timeoutMs: 40,
      // 轮询间隔是 1 秒，压到 10ms，让用例秒级结束
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
      now: () => 1000,
    }).run(new AbortController().signal)) {
      if (ev.type === 'failed') failures.push({ code: ev.code, message: ev.message })
    }

    assert.equal(failures.length, 1)
    assert.equal(failures[0]?.code, 'AUTH_TIMEOUT')
    // 说清「多久没等到」，而不是把设备码的 15 分钟当成本地超时
    assert.match(failures[0]?.message ?? '', /40 毫秒/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccount：没有存档 → offline，且不抛错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-res-'))
  try {
    const r = await resolveAccount({ storePath: authStorePath(dir) })
    assert.equal(r.kind, 'offline')
    assert.match(r.kind === 'offline' ? r.reason : '', /没有登录/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccount：点名要的账号不存在 → 大声失败，不静默降级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-res2-'))
  try {
    await assert.rejects(
      () => resolveAccount({ storePath: authStorePath(dir), selector: 'Steve' }),
      (err: unknown) => err instanceof AuthError && err.code === 'AUTH_ACCOUNT_NOT_FOUND',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccount：过期且刷新成功 → online + refreshed，存档已更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-res3-'))
  try {
    const storePath = authStorePath(dir)
    const expired: AuthAccount = {
      ...account(0),
      expiresAt: 1000,
      refreshToken: 'rt',
      clientId: 'client-1',
    }
    upsertAccount(storePath, expired)

    const http = httpRecorder(
      happyPath({
        '/token': () => ({
          status: 200,
          body: { access_token: 'new', refresh_token: 'rt-9', expires_in: 3600 },
        }),
      }),
    )
    const r = await resolveAccount({ storePath, http, now: () => 5000 })
    assert.equal(r.kind, 'online')
    assert.equal(r.kind === 'online' ? r.refreshed : false, true)
    assert.equal(loadStore(storePath).accounts[0]?.refreshToken, 'rt-9')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccount：默认账号刷不动 → 退回离线并说明原因', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-res4-'))
  try {
    const storePath = authStorePath(dir)
    upsertAccount(storePath, { ...account(0), expiresAt: 1000 })

    const http = httpRecorder(
      happyPath({ '/token': () => ({ status: 400, body: { error: 'invalid_grant' } }) }),
    )
    const r = await resolveAccount({ storePath, http, now: () => 5000 })
    assert.equal(r.kind, 'offline')
    assert.match(r.kind === 'offline' ? r.reason : '', /刷新失败/)
    assert.match(r.kind === 'offline' ? r.reason : '', /Notch/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAccount：点名账号刷新失败 → 抛错，不退化成离线身份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-res5-'))
  try {
    const storePath = authStorePath(dir)
    upsertAccount(storePath, { ...account(0), expiresAt: 1000 })
    const http = httpRecorder(
      happyPath({ '/token': () => ({ status: 400, body: { error: 'invalid_grant' } }) }),
    )
    await assert.rejects(() =>
      resolveAccount({ storePath, selector: 'Notch', http, now: () => 5000 }),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createLogin 的失败走 failed 事件，不是抛异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-auth-op2-'))
  try {
    const http = httpRecorder(() => ({
      status: 400,
      body: {
        error: 'unauthorized_client',
        error_description: 'not a valid application identifier',
      },
    }))
    let code: string | undefined
    let hint: string | undefined
    for await (const ev of createLogin({
      clientId: 'bad-app',
      storePath: authStorePath(dir),
      http,
    }).run(new AbortController().signal)) {
      if (ev.type === 'failed') {
        code = ev.code
        hint = ev.hint
      }
    }
    assert.equal(code, 'AUTH_DEVICE_CODE_FAILED')
    assert.match(hint ?? '', /client-id/)
    assert.equal(loadStore(authStorePath(dir)).accounts.length, 0, '失败不该写档')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
