import assert from 'node:assert/strict'
import test from 'node:test'

import { extractLogPath } from './parse.js'

test('取会话日志路径：路径含空格也能取全', () => {
  const out = [
    '  已到时限结束  45.1s · 326 行日志',
    '',
    '  日志  C://Users//PC//WorkBuddy AI\\mc\\instances\\fo\\logs\\2026-11-08T09-00-54.log',
    '',
  ].join('\n')
  assert.equal(
    extractLogPath(out),
    'C://Users//PC//WorkBuddy AI\\mc\\instances\\fo\\logs\\2026-11-08T09-00-54.log',
  )
})

test('上一行以「N 行日志」结尾时不会被当成路径的一部分', () => {
  const out = ['  正常退出  28.6s · 68 行日志', '  日志  D://mc//a.log'].join('\n')
  assert.equal(extractLogPath(out), 'D://mc//a.log')
})

test('没有日志行时返回 undefined', () => {
  assert.equal(extractLogPath('[INFO] hello'), undefined)
})
