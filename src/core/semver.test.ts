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

test('`1.20-x.y.z` 的后缀参与比较（issue #14）', () => {
  // supplementaries 的真实写法：breaks: { supplementaries: "<=1.20-2.7.32" }
  assert.equal(satisfiesRange('1.20-3.1.43', '<=1.20-2.7.32'), 'violated')
  assert.equal(satisfiesRange('1.20-2.7.10', '<=1.20-2.7.32'), 'satisfied')
  assert.equal(satisfiesRange('1.20-2.7.32', '<=1.20-2.7.32'), 'satisfied')
  // 下界同样要生效
  assert.equal(satisfiesRange('1.20-3.1.43', '>=1.20-3.0'), 'satisfied')
  assert.equal(satisfiesRange('1.20-2.7.32', '>=1.20-3.0'), 'violated')
})

test('`1.20.1-47.3.22` 这类 Forge 版本也能分出大小', () => {
  assert.equal(satisfiesRange('1.20.1-47.3.22', '>=1.20.1-47.2.0'), 'satisfied')
  assert.equal(satisfiesRange('1.20.1-47.1.0', '>=1.20.1-47.2.0'), 'violated')
  // Maven 范围照旧
  assert.equal(satisfiesRange('1.20.1-47.3.22', '[1.20.1,1.21)'), 'satisfied')
})

test('build metadata（+ 之后）不参与比较', () => {
  assert.equal(satisfiesRange('0.92.12+1.20.1', '=0.92.12'), 'satisfied')
  assert.equal(satisfiesRange('0.4.32+1802ada577', '>=0.4.32'), 'satisfied')
})

test('末尾孤零零的构建号不算版本段（flywheel 1.0.5-264）', () => {
  // 真实写法：create 要求 >=1.0.5-264，实际 JiJ 里是 1.0.5+1.20.1.build.264
  assert.equal(satisfiesRange('1.0.5+1.20.1.build.264', '>=1.0.5-264'), 'satisfied')
  assert.equal(satisfiesRange('1.0.2+1.20.1', '>=1.0.5-264'), 'violated')
})

test('Forge 的裸版本号是推荐版本，不是精确匹配', () => {
  // VersionRange.createFromVersionSpec("1.0.0").hasRestrictions() === false
  assert.equal(satisfiesRange('2.6.1', '1.0.0', 'forge'), 'satisfied')
  assert.equal(satisfiesRange('0.9.0', '1.0.0', 'forge'), 'satisfied')
  // Fabric 同一份写法是精确匹配
  assert.equal(satisfiesRange('2.6.1', '1.0.0', 'fabric'), 'violated')
  assert.equal(satisfiesRange('1.0.0', '1.0.0', 'fabric'), 'satisfied')
})

test('Forge 方言下显式比较符仍然生效', () => {
  assert.equal(satisfiesRange('1.1.0', '>=1.2.0', 'forge'), 'violated')
  assert.equal(satisfiesRange('1.2.0', '>=1.2.0', 'forge'), 'satisfied')
  // 1.12.x 这类前缀写法在 Forge 下也照旧按前缀比
  assert.equal(satisfiesRange('1.12.2', '1.12.x', 'forge'), 'satisfied')
  assert.equal(satisfiesRange('1.13.0', '1.12.x', 'forge'), 'violated')
  // Maven 范围不受方言影响
  assert.equal(satisfiesRange('1.4.0', '[1.5,)', 'forge'), 'violated')
})
