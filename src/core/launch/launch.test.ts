import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveLayout } from '../layout.js'
import { collect } from '../operation.js'
import type { VersionJson } from '../version/types.js'
import { expandArgs, substitute } from './command.js'
import type { LaunchEnv } from './env.js'
import { detectEnv, rulesAllow } from './env.js'
import { createLaunchPlan } from './index.js'
import { buildLaunchPlan } from './plan.js'

const win: LaunchEnv = {
  os: 'windows',
  arch: 'x86_64',
  osVersion: '10.0',
  features: {},
}
const { osVersion: _osVersion, ...winBase } = win
const mac: LaunchEnv = { ...winBase, os: 'osx' }

test('没有 rules 的库默认允许', () => {
  assert.equal(rulesAllow(undefined, win), true)
  assert.equal(rulesAllow([], win), true)
})

test('allow 规则只在匹配的平台生效', () => {
  const rules = [{ action: 'allow' as const, os: { name: 'osx' as const } }]
  assert.equal(rulesAllow(rules, win), false)
  assert.equal(rulesAllow(rules, mac), true)
})

test('最后一条匹配的规则生效，顺序有意义', () => {
  const rules = [
    { action: 'allow' as const },
    { action: 'disallow' as const, os: { name: 'osx' as const } },
  ]
  assert.equal(rulesAllow(rules, win), true)
  assert.equal(rulesAllow(rules, mac), false)
})

test('arch 不匹配时不生效', () => {
  const rules = [{ action: 'allow' as const, os: { arch: 'x86' as const } }]
  assert.equal(rulesAllow(rules, win), false)
})

test('features 开关参与判定', () => {
  const rules = [{ action: 'allow' as const, features: { is_demo_user: true } }]
  assert.equal(rulesAllow(rules, win), false)
  assert.equal(rulesAllow(rules, { ...win, features: { is_demo_user: true } }), true)
})

test('expandArgs 展开带 rules 的对象', () => {
  const out = expandArgs(
    [
      '-Xmx1G',
      { rules: [{ action: 'allow', os: { name: 'osx' } }], value: '-XstartOnFirstThread' },
      { value: ['-Da', '-Db'] },
    ],
    win,
  )
  assert.deepEqual(out, ['-Xmx1G', '-Da', '-Db'])
})

test('substitute 替换已知变量，保留未知占位符', () => {
  const vars = { name: 'Steve', cp: 'a;b' }
  assert.equal(substitute('--username ${name}', vars), '--username Steve')
  assert.equal(substitute('-cp ${cp}', vars), '-cp a;b')
  assert.equal(substitute('${unknown}', vars), '${unknown}')
})

function fakeVersion(): VersionJson {
  return {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', sha1: 'x', size: 1, url: 'https://example.com/5.json' },
    libraries: [
      {
        name: 'common:lib:1',
        downloads: {
          artifact: { path: 'common/lib/1/lib-1.jar', sha1: 'x', size: 1, url: 'u' },
        },
      },
      {
        name: 'mac:only:1',
        downloads: {
          artifact: { path: 'mac/only/1/only-1.jar', sha1: 'x', size: 1, url: 'u' },
        },
        rules: [{ action: 'allow', os: { name: 'osx' } }],
      },
      {
        name: 'native:1',
        natives: { windows: 'natives-windows' },
        downloads: { classifiers: {} },
      },
    ],
    arguments: {
      jvm: ['-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--clientId', '${clientid}'],
    },
  }
}

test('createLaunchPlan 把实例配置的 extraJvmArgs 交给启动命令（config → plan.args）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bp-launch-jvmargs-'))
  try {
    const layout = resolveLayout(dir, 'test')
    const version = fakeVersion()
    mkdirSync(join(layout.versions, version.id), { recursive: true })
    writeFileSync(layout.versionJson(version.id), JSON.stringify(version))

    const plan = await collect(
      createLaunchPlan({
        versionId: version.id,
        layout,
        java: 'java',
        maxMemoryMiB: 2048,
        extraJvmArgs: ['--add-opens', 'java.base/java.lang=ALL-UNNAMED'],
      }),
    )
    const at = plan.args.indexOf('--add-opens')
    assert.ok(at > 0, '--add-opens 应该出现在启动参数里')
    assert.equal(plan.args[at - 1], '-Xmx2048M', '追加参数应排在 -Xmx 之后')
    assert.equal(plan.args[at + 1], 'java.base/java.lang=ALL-UNNAMED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildLaunchPlan 只把当前平台需要的 jar 放进 classpath', () => {
  const plan = buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/mc', 'test'),
    version: fakeVersion(),
    rootVersionId: '1.20.1',
    env: win,
    username: 'Steve',
  })
  assert.equal(plan.classpath.length, 2, 'common lib + client jar')
  assert.ok(plan.classpath.some((p) => p.includes('lib-1.jar')))
  assert.ok(!plan.classpath.some((p) => p.includes('only-1.jar')), 'mac 专用库被排除')
  assert.ok(
    plan.classpath.some((p) => p.endsWith('1.20.1.jar')),
    'client jar 在末尾',
  )
})

test('buildLaunchPlan 替换所有已知占位符，不留下 ${...}', () => {
  const plan = buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/mc', 'test'),
    version: fakeVersion(),
    rootVersionId: '1.20.1',
    env: win,
    username: 'Steve',
  })
  const leftovers = plan.args.filter((a) => /\$\{[a-zA-Z0-9_]+\}/.test(a))
  assert.deepEqual(leftovers, [], `未替换的占位符：${leftovers.join(', ')}`)
  assert.ok(plan.args.includes('Steve'))
  assert.equal(plan.mainClass, 'net.minecraft.client.main.Main')
})

test('缺失文件包含 client jar、libraries 与 assetIndex', () => {
  const plan = buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/bp-definitely-missing-dir', 'test'),
    version: fakeVersion(),
    rootVersionId: '1.20.1',
    env: win,
    username: 'Steve',
  })
  assert.ok(plan.missing.some((m) => m.endsWith('1.20.1.jar')))
  assert.ok(plan.missing.some((m) => m.includes('lib-1.jar')))
  assert.ok(plan.missing.some((m) => m.endsWith('5.json')))
})

test('detectEnv 产出合法的 os/arch', () => {
  const env = detectEnv()
  assert.ok(['windows', 'osx', 'linux'].includes(env.os))
  assert.ok(['x86', 'x86_64', 'arm64'].includes(env.arch))
})

/** 1.20.1 的真实模板里这几个变量都在 game args 里 */
function authVersion(): VersionJson {
  const base = fakeVersion()
  return {
    ...base,
    arguments: {
      jvm: ['-cp', '${classpath}'],
      game: [
        '--username',
        '${auth_player_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--clientId',
        '${clientid}',
        '--xuid',
        '${auth_xuid}',
        '--userType',
        '${user_type}',
      ],
    },
  }
}

function planFor(account?: Parameters<typeof buildLaunchPlan>[0]['account']) {
  return buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/mc', 'test'),
    version: authVersion(),
    rootVersionId: '1.20.1',
    env: win,
    username: 'Steve',
    ...(account === undefined ? {} : { account }),
  })
}

test('离线身份：按 OfflinePlayer 规则派生 uuid、令牌 0、userType legacy', () => {
  const plan = planFor()
  assert.equal(plan.mode, 'offline')
  assert.equal(plan.playerName, 'Steve')
  // UUID.nameUUIDFromBytes("OfflinePlayer:Steve")：与官方离线服务器一致
  assert.ok(plan.args.includes('5627dd98e6be3c21b8a8e92344183641'))
  assert.ok(plan.args.includes('legacy'))
  assert.ok(!plan.args.includes('msa'))
})

test('正版身份：真实 uuid / 令牌 / xuid，且 userType 必须是 msa', () => {
  const plan = planFor({
    uuid: '069a79f444e94726a5befca90e38aaf5',
    name: 'Notch',
    accessToken: 'mc-token',
    expiresAt: Date.now() + 3_600_000,
    xuid: '2535410000000000',
    refreshToken: 'rt',
    clientId: 'c',
    obtainedAt: 1,
    userType: 'msa',
  })
  assert.equal(plan.mode, 'online')
  assert.equal(plan.playerName, 'Notch')
  assert.ok(plan.args.includes('069a79f444e94726a5befca90e38aaf5'))
  assert.ok(plan.args.includes('mc-token'))
  assert.ok(plan.args.includes('2535410000000000'))
  assert.ok(plan.args.includes('msa'), 'userType 写 legacy 会让游戏忽略令牌')
  assert.ok(!plan.args.includes('legacy'))
  assert.equal(plan.args.filter((a) => /\$\{[a-zA-Z0-9_]+\}/.test(a)).length, 0)
})

test('正版但没拿到 xuid：退化成占位值，不产生空参数', () => {
  const plan = planFor({
    uuid: '069a79f444e94726a5befca90e38aaf5',
    name: 'Notch',
    accessToken: 'mc-token',
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: 1,
    userType: 'msa',
  })
  const i = plan.args.indexOf('--xuid')
  assert.equal(plan.args[i + 1], '0')
})

test('展示用 commandLine 脱敏，args 保留真实令牌（启动必需）', () => {
  const plan = planFor({
    uuid: '069a79f444e94726a5befca90e38aaf5',
    name: 'Notch',
    accessToken: 'mc-token',
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: 1,
    userType: 'msa',
  })
  assert.ok(plan.args.includes('mc-token'), '真正传给 java 的参数不能改')
  assert.doesNotMatch(plan.commandLine, /mc-token/)
  assert.match(plan.commandLine, /--accessToken \*\*\*/)
})
