import assert from 'node:assert/strict'
import { test } from 'node:test'

import { satisfiesRange } from './semver.js'

test('单边比较', () => {
  assert.equal(satisfiesRange('0.16.14', '>=0.16.10'), 'satisfied')
  assert.equal(satisfiesRange('0.15.11', '>=0.16.10'), 'violated')
  assert.equal(satisfiesRange('1.20.1', '>1.20.1'), 'violated')
  assert.equal(satisfiesRange('1.20.1', '<=1.20.1'), 'satisfied')
})

test('精确匹配', () => {
  assert.equal(satisfiesRange('1.20.1', '1.20.1'), 'satisfied')
  assert.equal(satisfiesRange('1.20.1', '=1.20.1'), 'satisfied')
  assert.equal(satisfiesRange('1.20.2', '1.20.1'), 'violated')
})

test('空格分隔是 AND', () => {
  assert.equal(satisfiesRange('1.20.1', '>=1.20.1 <1.21'), 'satisfied')
  assert.equal(satisfiesRange('1.21', '>=1.20.1 <1.21'), 'violated')
  assert.equal(satisfiesRange('1.19.4', '>=1.20.1 <1.21'), 'violated')
})

test('|| 是 OR', () => {
  assert.equal(satisfiesRange('1.19.4', '>=1.20.1 || 1.19.4'), 'satisfied')
  assert.equal(satisfiesRange('1.18', '>=1.20.1 || 1.19.4'), 'violated')
})

test('x 通配只比较给出的段', () => {
  assert.equal(satisfiesRange('1.20.1', '1.20.x'), 'satisfied')
  assert.equal(satisfiesRange('1.20.4', '1.20.x'), 'satisfied')
  assert.equal(satisfiesRange('1.21', '1.20.x'), 'violated')
})

test('* 和空串放行', () => {
  assert.equal(satisfiesRange('1.20.1', '*'), 'satisfied')
  assert.equal(satisfiesRange('1.20.1', ''), 'satisfied')
})

test('Maven 半开区间', () => {
  assert.equal(satisfiesRange('1.20.1', '[1.20.1,1.21)'), 'satisfied')
  assert.equal(satisfiesRange('1.21', '[1.20.1,1.21)'), 'violated')
  assert.equal(satisfiesRange('1.19', '[1.20.1,1.21)'), 'violated')
})

test('Maven 开区间', () => {
  assert.equal(satisfiesRange('0.6.10', '[0.6.10,)'), 'satisfied')
  assert.equal(satisfiesRange('0.6.9', '[0.6.10,)'), 'violated')
})

test('Maven 闭区间上界', () => {
  assert.equal(satisfiesRange('1.21', '(,1.21]'), 'satisfied')
  assert.equal(satisfiesRange('1.21.1', '(,1.21]'), 'violated')
})

test('预发布后缀不影响主版本比较', () => {
  assert.equal(satisfiesRange('1.20.1-beta.2', '>=1.20.1'), 'satisfied')
})

test('无法解析的版本返回 unknown 而不是猜', () => {
  assert.equal(satisfiesRange('not-a-version', '>=1.0.0'), 'unknown')
})

test('~ 锁次版本（Fabulously Optimized 的真实写法）', () => {
  assert.equal(satisfiesRange('1.21.1', '~1.21'), 'satisfied')
  assert.equal(satisfiesRange('1.21.9', '~1.21'), 'satisfied')
  assert.equal(satisfiesRange('1.22', '~1.21'), 'violated')
  assert.equal(satisfiesRange('1.21.0', '~1.21.1'), 'violated')
  assert.equal(satisfiesRange('1.21.5', '~1.21.1'), 'satisfied')
})

test('~ 与显式上界组合', () => {
  // 真实案例：controlify / zoomify 写的 "~1.21 <1.21.2"
  assert.equal(satisfiesRange('1.21.1', '~1.21 <1.21.2'), 'satisfied')
  assert.equal(satisfiesRange('1.21.3', '~1.21 <1.21.2'), 'violated')
})

test('^ 锁主版本', () => {
  assert.equal(satisfiesRange('1.21.1', '^1.20'), 'satisfied')
  assert.equal(satisfiesRange('2.0.0', '^1.20'), 'violated')
  // 0.x 的约定：锁次版本
  assert.equal(satisfiesRange('0.5.9', '^0.5.1'), 'satisfied')
  assert.equal(satisfiesRange('0.6.0', '^0.5.1'), 'violated')
})

test('看不懂的写法返回 unknown，不当作违规', () => {
  assert.equal(satisfiesRange('1.21.1', 'next-please'), 'unknown')
  assert.equal(satisfiesRange('1.21.1', '>1.0.0 next-please'), 'unknown')
})
