/**
 * 依赖方向守卫。
 *
 * ADR-0001 承诺「换实现只改 sources/，core 一行不动」。这条承诺靠人记是记不住的：
 * `core/deploy.ts` 曾经直接 import `sources/curseforge`，而 Modrinth 却是注入的，
 * 两种写法并存了很久。没有 lint 规则时，用一条测试守住同一个边界。
 *
 * 第二组守卫固化 core 内部的分层与环：层级表写在 MODULE_LAYERS；
 * 反向依赖、文件级循环、模块级循环的基线当前都为零，出现即回归。
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CORE = dirname(fileURLToPath(import.meta.url))

/**
 * core 内模块的分层，数字越小越底层。只能从高层指向低层或同层；
 * 新增模块必须先在这里登记，否则守卫会报未登记。
 */
const MODULE_LAYERS: Readonly<Record<string, number>> = {
  'core/events': 0,
  'core/deps': 1,
  'core/modmeta': 1,
  'core/pack': 1,
  'core/sources': 1,
  'core/version': 1,
  'core/assets': 2,
  'core/auth': 2,
  'core/download': 2,
  'core/host': 2,
  'core/instance': 2,
  'core/java': 2,
  'core/diagnostics': 3,
  'core/launch': 3,
  'core/operations': 3,
  'core/preflight': 3,
  'core/setup': 3,
  'core/deploy': 4,
}

/**
 * 根目录文件的层级。没登记的是纯内核与工具（L0）；
 * 领域契约与宿主探测按实际依赖单独标注。
 *
 * `instance.ts` 是 L0 纯类型（Instance / LoaderRef / HostProfile），不是 `instance/`
 * 的入口。不要为了消除同名把它移进 `instance/`：那会让 events / pack 反向依赖 L2。
 */
const ROOT_LAYERS: Readonly<Record<string, number>> = {
  'content-source.ts': 1,
  'curseforge.ts': 1,
}

/** 反向依赖基线。当前为零：任何低层 import 高层都算回归。 */
const KNOWN_UPWARD: readonly string[] = []

/** 文件级循环基线。当前为零：任何新环都算回归。 */
const KNOWN_FILE_CYCLES: readonly (readonly string[])[] = []

/** 模块级循环基线。当前为零：任何新环都算回归。 */
const KNOWN_MODULE_CYCLES: readonly (readonly string[])[] = []

function sourceFiles(): string[] {
  return readdirSync(CORE, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => name.split(sep).join('/'))
}

/** 一个文件里所有落在 core 内的相对 import 目标（相对 core/，统一 / 分隔）。 */
function importsOf(file: string): string[] {
  const text = readFileSync(resolve(CORE, file), 'utf8')
  const targets: string[] = []
  for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)'(\.[^']+)'/g)) {
    const spec = match[1] ?? ''
    const abs = resolve(CORE, dirname(file), spec).replace(/\.(?:js|ts)$/, '')
    const rel = relative(CORE, abs).split(sep).join('/')
    if (rel.startsWith('..') || rel.endsWith('.test')) continue
    if (!existsSync(resolve(CORE, `${rel}.ts`))) continue
    targets.push(`${rel}.ts`)
  }
  return targets
}

function importGraph(): Map<string, readonly string[]> {
  const graph = new Map<string, readonly string[]>()
  for (const file of sourceFiles()) graph.set(file, importsOf(file))
  return graph
}

function moduleOf(file: string): string {
  const slash = file.indexOf('/')
  return slash === -1 ? 'core' : `core/${file.slice(0, slash)}`
}

function layerOf(file: string): number | undefined {
  if (!file.includes('/')) return ROOT_LAYERS[file] ?? 0
  return MODULE_LAYERS[moduleOf(file)]
}

function unknownModules(): string[] {
  return [
    ...new Set(
      sourceFiles()
        .filter((file) => file.includes('/'))
        .map(moduleOf),
    ),
  ]
    .filter((module) => MODULE_LAYERS[module] === undefined)
    .sort()
}

/** 低层模块 import 高层模块的边。 */
function upwardEdges(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const out = new Set<string>()
  for (const [source, targets] of graph) {
    const from = layerOf(source)
    if (from === undefined) continue
    for (const target of targets) {
      const to = layerOf(target)
      if (to === undefined || from >= to) continue
      out.add(`${moduleOf(source)} -> ${moduleOf(target)}`)
    }
  }
  return [...out].sort()
}

function moduleGraph(graph: ReadonlyMap<string, readonly string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [source, targets] of graph) {
    const from = moduleOf(source)
    const list = out.get(from) ?? []
    for (const target of targets) {
      const to = moduleOf(target)
      if (to !== from) list.push(to)
    }
    out.set(from, [...new Set(list)])
  }
  return out
}

/** Tarjan：返回所有大小大于 1 的强连通分量。 */
function strongComponents(
  nodes: readonly string[],
  graph: ReadonlyMap<string, readonly string[]>,
): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []

  const visit = (node: string): void => {
    index.set(node, next)
    low.set(node, next)
    next += 1
    stack.push(node)
    onStack.add(node)

    for (const target of graph.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0))
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0))
      }
    }

    if (low.get(node) === index.get(node)) {
      const group: string[] = []
      let member = ''
      do {
        member = stack.pop() ?? ''
        onStack.delete(member)
        group.push(member)
      } while (member !== node)
      if (group.length > 1) out.push(group)
    }
  }

  for (const node of nodes) {
    if (!index.has(node)) visit(node)
  }
  return out
}

/** 把「一组一组」的多行结构压成可比较的字符串数组。 */
function normalize(groups: readonly (readonly string[])[]): string[] {
  return groups.map((group) => [...group].sort().join(' | ')).sort()
}

test('core 不 import 外层 sources / cli / mcp', () => {
  const violations: string[] = []

  for (const name of readdirSync(CORE, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const file = resolve(CORE, name)
    const text = readFileSync(file, 'utf8')
    // 同时覆盖静态 import 与动态 import()：core 不能因为换一种写法就绕过边界
    for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)'(\.[^']+)'/g)) {
      const spec = match[1] ?? ''
      const target = resolve(dirname(file), spec)
      if (/[\\/]src[\\/](sources|cli|mcp)[\\/]/.test(target)) {
        violations.push(`${name} -> ${spec}`)
      }
    }
  }

  assert.deepEqual(violations, [], 'core 只能依赖 core 内部与 node 内置模块')
})

test('core 不直接写 stdout/stderr', () => {
  const violations: string[] = []

  for (const name of readdirSync(CORE, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
    const text = readFileSync(resolve(CORE, name), 'utf8')
    for (const match of text.matchAll(/\bprocess\.(?:stdout|stderr)\s*\./g)) {
      violations.push(`${name}: ${match[0]}`)
    }
  }

  assert.deepEqual(violations, [], 'core 只能通过 OpEvent 输出；直接写 stdout/stderr 会绕过消费者')
})

test('core 分层：只能依赖更低或同层的模块', () => {
  assert.deepEqual(unknownModules(), [], '新增模块先在 MODULE_LAYERS 登记层级')
  assert.deepEqual(
    upwardEdges(importGraph()),
    [...KNOWN_UPWARD].sort(),
    '低层 import 高层是反向依赖；只能减少。修掉一条时同步删掉基线',
  )
})

test('core 没有文件级循环', () => {
  const graph = importGraph()
  assert.deepEqual(
    normalize(strongComponents([...graph.keys()], graph)),
    normalize(KNOWN_FILE_CYCLES),
    '出现新的文件级循环',
  )
})

test('core 没有模块级循环', () => {
  const graph = moduleGraph(importGraph())
  assert.deepEqual(
    normalize(strongComponents([...graph.keys()], graph)),
    normalize(KNOWN_MODULE_CYCLES),
    '出现新的模块级循环',
  )
})
