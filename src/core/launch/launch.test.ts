import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveLayout } from '../layout.js'
import type { VersionJson } from '../version/types.js'
import { expandArgs, substitute } from './command.js'
import { detectEnv, rulesAllow } from './env.js'
import type { LaunchEnv } from './env.js'
import { buildLaunchPlan } from './plan.js'

const win: LaunchEnv = {
  os: 'windows',
  arch: 'x86_64',
  osVersion: '10.0',
  features: {},
}
const mac: LaunchEnv = { ...win, os: 'osx', osVersion: undefined }

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

test('buildLaunchPlan 只把当前平台需要的 jar 放进 classpath', () => {
  const plan = buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/mc', 'test'),
    version: fakeVersion(),
    env: win,
    username: 'Steve',
  })
  assert.equal(plan.classpath.length, 2, 'common lib + client jar')
  assert.ok(plan.classpath.some((p) => p.includes('lib-1.jar')))
  assert.ok(!plan.classpath.some((p) => p.includes('only-1.jar')), 'mac 专用库被排除')
  assert.ok(plan.classpath.some((p) => p.endsWith('1.20.1.jar')), 'client jar 在末尾')
})

test('buildLaunchPlan 替换所有已知占位符，不留下 ${...}', () => {
  const plan = buildLaunchPlan({
    java: 'java',
    layout: resolveLayout('/tmp/mc', 'test'),
    version: fakeVersion(),
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
