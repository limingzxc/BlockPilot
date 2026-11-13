/**
 * CLI 依赖方向守卫。
 *
 * core 的边界由 `core/architecture.test.ts` 守住；这里守住 consumer 内部：
 * 渲染不依赖消费器、输出不依赖渲染、命令实现不反向依赖入口与注册表，
 * 目录之间也不允许出现循环依赖。
 * 这些规则靠人记会漂移，用一条测试固定下来。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const CLI = dirname(fileURLToPath(import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(resolve(CLI, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => resolve(CLI, dir, name))
}

/** 文件里所有相对 import 的目标，返回相对 cli/ 的路径（无扩展名，统一 / 分隔）。 */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const targets: string[] = []
  for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)'(\.[^']+)'/g)) {
    const spec = match[1] ?? ''
    const target = resolve(dirname(file), spec).replace(/\.(?:js|ts)$/, '')
    if (!target.startsWith(`${CLI}${sep}`)) continue
    targets.push(
      target
        .slice(CLI.length + 1)
        .split(sep)
        .join('/'),
    )
  }
  return targets
}

function violations(dir: string, forbidden: RegExp): string[] {
  const out: string[] = []
  for (const file of sourceFiles(dir)) {
    for (const target of importsOf(file)) {
      if (forbidden.test(target)) {
        out.push(`${file.slice(CLI.length + 1)} -> ${target}`)
      }
    }
  }
  return out
}

/** 允许被命令/渲染层直接引用的 core 纯工具（无 IO、无 Operation）。 */
const PURE_CORE = new Set(['../../core/errors.js', '../../core/hints.js', '../../core/redact.js'])

/** 命令层的值依赖基线：目标是 CLI 之外的模块。只减不增。 */
const COMMAND_OUTSIDE_VALUES: readonly string[] = [
  'assets.ts -> ../../core/assets/index.js',
  'config.ts -> ../../core/instance/config.js',
  'diag.ts -> ../../core/diagnostics/artifacts.js',
  'diag.ts -> ../../core/diagnostics/index.js',
  'forge.ts -> ../../core/setup/vanilla.js',
  'install.ts -> ../../assembly.js',
  'install.ts -> ../../core/download/index.js',
  'install.ts -> ../../core/host/index.js',
  'install.ts -> ../../core/preflight/index.js',
  'java.ts -> ../../core/java/index.js',
  'java.ts -> ../../core/java/install.js',
  'launch.ts -> ../../core/launch/index.js',
  'logs.ts -> ../../core/launch/logfile.js',
  'preflight.ts -> ../../assembly.js',
  'preflight.ts -> ../../core/host/index.js',
  'preflight.ts -> ../../core/preflight/index.js',
  'run.ts -> ../../core/launch/index.js',
  'run.ts -> ../../core/launch/run.js',
  'setup.ts -> ../../core/preflight/assets.js',
  'setup.ts -> ../../core/setup/vanilla.js',
  'setup.ts -> ../../core/version/game-version.js',
  'setup.ts -> ../../core/version/java-major.js',
  'update.ts -> ../../assembly.js',
  'update.ts -> ../../core/instance/loader-update.js',
  'update.ts -> ../../core/instance/lock.js',
  'update.ts -> ../../core/instance/update.js',
  'verify.ts -> ../../core/instance/lock.js',
]

/** render 的值依赖基线：只允许纯格式化函数，不允许 Operation / IO。 */
const RENDER_CORE_VALUES: readonly string[] = [
  'assets.ts -> ../../core/preflight/assets.js',
  'assets.ts -> ../../core/version/game-version.js',
]

/** use-cases 仍然直接引用 output 的基线；当前为零。 */
const USE_CASE_OUTPUT_IMPORTS: readonly string[] = []

/** use-cases 直接写 stdout/stderr 的基线（按文件计数）；当前为零。 */
const USE_CASE_STREAM_WRITES: Readonly<Record<string, number>> = {}

/** use-cases 单文件的 import 面基线。只减不增。 */
const USE_CASE_FANOUT: Readonly<Record<string, number>> = {
  'auth.ts': 4,
  'deploy.ts': 12,
  'instance.ts': 2,
  'java.ts': 2,
  'loader.ts': 5,
}

function isTypeOnly(clause: string): boolean {
  const text = clause.trim()
  if (text.startsWith('type ')) return true
  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return true
    return inner.split(',').every((part) => part.trim().startsWith('type '))
  }
  return false
}

/** 文件里的值 import（排除 `import type` 与全 type 的内联 specifier）。 */
function valueImportsOf(file: string): { spec: string; target: string }[] {
  const text = readFileSync(file, 'utf8')
  const out: { spec: string; target: string }[] = []
  for (const match of text.matchAll(/import\s+([^'"]*?)\s+from\s+'(\.[^']+)'/g)) {
    if (isTypeOnly(match[1] ?? '')) continue
    const spec = match[2] ?? ''
    const abs = resolve(dirname(file), spec).replace(/\.(?:js|ts)$/, '')
    const rel = relative(CLI, abs).split(sep).join('/')
    out.push({ spec, target: rel.startsWith('..') ? '' : rel })
  }
  return out
}

function relOf(file: string): string {
  return relative(CLI, file).split(sep).join('/')
}

function allSourceFiles(): string[] {
  return readdirSync(CLI, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => name.split(sep).join('/').replace(/\.ts$/, ''))
}

function moduleOf(file: string): string {
  const slash = file.indexOf('/')
  return slash === -1 ? 'cli' : `cli/${file.slice(0, slash)}`
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

function normalize(groups: readonly (readonly string[])[]): string[] {
  return groups.map((group) => [...group].sort().join(' | ')).sort()
}

test('CLI 内部没有文件级与目录级循环', () => {
  const graph = new Map<string, readonly string[]>()
  for (const file of allSourceFiles()) {
    graph.set(file, importsOf(resolve(CLI, `${file}.ts`)))
  }
  assert.deepEqual(
    normalize(strongComponents([...graph.keys()], graph)),
    [],
    '文件之间出现了循环 import',
  )

  const modules = moduleGraph(graph)
  assert.deepEqual(
    normalize(strongComponents([...modules.keys()], modules)),
    [],
    'CLI 目录之间出现了循环依赖',
  )
})

test('命令只依赖 CLI 的声明/渲染/用例层；core 值依赖走基线', () => {
  const found: string[] = []
  for (const file of sourceFiles('commands')) {
    const name = relOf(file).slice('commands/'.length)
    for (const imp of valueImportsOf(file)) {
      if (PURE_CORE.has(imp.spec)) continue
      if (/^(?:command|shared|use-cases|render|output|consume)\//.test(imp.target)) continue
      found.push(`${name} -> ${imp.spec}`)
    }
  }
  assert.deepEqual(
    found.sort(),
    [...COMMAND_OUTSIDE_VALUES].sort(),
    '命令层出现了新的越界值依赖；新流程请放进 use-cases/',
  )
})

test('render 不引用 core 的实现（值），只用类型与输出', () => {
  const found: string[] = []
  for (const file of sourceFiles('render')) {
    const name = relOf(file).slice('render/'.length)
    for (const imp of valueImportsOf(file)) {
      if (PURE_CORE.has(imp.spec)) continue
      if (imp.spec.startsWith('../../core/')) found.push(`${name} -> ${imp.spec}`)
    }
  }
  assert.deepEqual(
    found.sort(),
    [...RENDER_CORE_VALUES].sort(),
    'render 新增了 core 值依赖；纯渲染不应依赖 core 的实现',
  )
})

test('use-cases 不依赖 output/render，也不直接写 stdout/stderr', () => {
  const imports: string[] = []
  const writes: Record<string, number> = {}
  for (const file of sourceFiles('use-cases')) {
    const name = relOf(file).slice('use-cases/'.length)
    for (const imp of valueImportsOf(file)) {
      if (imp.spec.startsWith('../output/') || imp.spec.startsWith('../render/')) {
        imports.push(`${name} -> ${imp.spec}`)
      }
    }
    const count = (readFileSync(file, 'utf8').match(/\bprocess\.(?:stdout|stderr)\s*\./g) ?? [])
      .length
    if (count > 0) writes[name] = count
  }
  assert.deepEqual(
    imports.sort(),
    [...USE_CASE_OUTPUT_IMPORTS].sort(),
    'use-cases 新增了 output/render 依赖',
  )
  assert.deepEqual(writes, USE_CASE_STREAM_WRITES, 'use-cases 直接写了 stdout/stderr')
})

test('use-cases 单文件 fan-out 不超过基线', () => {
  const counts: Record<string, number> = {}
  for (const file of sourceFiles('use-cases')) {
    const specs = new Set(
      [...readFileSync(file, 'utf8').matchAll(/import\s+[^'"]*?\s+from\s+'(\.[^']+)'/g)].map(
        (m) => m[1] ?? '',
      ),
    )
    counts[relOf(file).slice('use-cases/'.length)] = specs.size
  }
  assert.deepEqual(counts, USE_CASE_FANOUT, 'use-cases 文件变胖了；拆分或显式更新基线')
})

test('render 只做渲染：不依赖消费器、命令声明与入口', () => {
  assert.deepEqual(
    violations('render', /^(?:consume\/|commands\/|command\/|index$|registry$)/),
    [],
    'render 只能依赖 output/ 与 core 类型',
  )
})

test('output 不依赖渲染、消费器与命令层', () => {
  assert.deepEqual(
    violations('output', /^(?:consume\/|render\/|commands\/|command\/|index$|registry$)/),
    [],
    'output 是最底层，只能依赖 core 纯类型/纯函数',
  )
})

test('command 声明层不依赖命令实现与入口', () => {
  assert.deepEqual(
    violations('command', /^(?:commands\/|index$|registry$)/),
    [],
    'define/context/usage 不应知道任何具体命令',
  )
})

test('命令实现不反向依赖入口与注册表', () => {
  assert.deepEqual(violations('commands', /^(?:index$|registry$)/), [])
})
