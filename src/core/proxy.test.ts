import assert from 'node:assert/strict'
import test from 'node:test'

import { javaProxyArgs } from './proxy.js'

test('Java 的代理参数：host 与 port 拆开，https 端口缺省 443', () => {
  assert.deepEqual(javaProxyArgs('http://127.0.0.1:1081'), [
    '-Dhttp.proxyHost=127.0.0.1',
    '-Dhttp.proxyPort=1081',
    '-Dhttps.proxyHost=127.0.0.1',
    '-Dhttps.proxyPort=1081',
  ])
  assert.deepEqual(javaProxyArgs('https://proxy.example.com'), [
    '-Dhttp.proxyHost=proxy.example.com',
    '-Dhttp.proxyPort=443',
    '-Dhttps.proxyHost=proxy.example.com',
    '-Dhttps.proxyPort=443',
  ])
})

test('没有代理时给空数组，不产生垃圾参数', () => {
  assert.deepEqual(javaProxyArgs(undefined), [])
  assert.deepEqual(javaProxyArgs(''), [])
})
