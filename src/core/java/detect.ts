import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { probeJava } from './probe.js'
import type { JavaInstall, JavaScanResult, JavaSource } from './types.js'

interface Candidate {
  readonly path: string
  readonly source: JavaSource
}

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const EXE = isWindows ? 'java.exe' : 'java'

function safeDirs(parent: string): string[] {
  try {
    return readdirSync(parent)
  } catch {
    return []
  }
}

/** 每个子目录下都可能有 bin/java */
function fromParent(parent: string | undefined, tail: string, source: JavaSource): Candidate[] {
  if (parent === undefined || !existsSync(parent)) return []
  return safeDirs(parent).map((name) => ({
    path: join(parent, name, tail, EXE),
    source,
  }))
}

/**
 * 列出所有可能的 java 可执行文件。不做探测，只列路径——探测要起 JVM，很慢。
 */
export function candidatePaths(managedDir?: string): Candidate[] {
  const out: Candidate[] = []
  const env = process.env

  const javaHome = env.JAVA_HOME
  if (javaHome !== undefined && javaHome !== '') {
    out.push({ path: join(javaHome, 'bin', EXE), source: 'java_home' })
  }

  if (managedDir !== undefined) {
    out.push(...fromParent(managedDir, 'bin', 'managed'))
  }

  if (isWindows) {
    const pf = env.ProgramFiles
    const pf86 = env['ProgramFiles(x86)']
    const local = env.LOCALAPPDATA

    // 厂商目录下一层就是 JDK 目录
    for (const parent of [
      pf === undefined ? undefined : join(pf, 'Java'),
      pf === undefined ? undefined : join(pf, 'Eclipse Adoptium'),
      pf === undefined ? undefined : join(pf, 'Eclipse Foundation'),
      pf === undefined ? undefined : join(pf, 'Microsoft'),
      pf === undefined ? undefined : join(pf, 'Zulu'),
      pf === undefined ? undefined : join(pf, 'BellSoft'),
      pf === undefined ? undefined : join(pf, 'Amazon Corretto'),
      pf86 === undefined ? undefined : join(pf86, 'Java'),
      local === undefined ? undefined : join(local, 'Programs', 'Eclipse Adoptium'),
    ]) {
      out.push(...fromParent(parent, 'bin', 'scan'))
    }
  } else if (isMac) {
    for (const root of [
      '/Library/Java/JavaVirtualMachines',
      '/System/Library/Java/JavaVirtualMachines',
    ]) {
      for (const name of safeDirs(root)) {
        out.push({
          path: join(root, name, 'Contents', 'Home', 'bin', EXE),
          source: 'scan',
        })
      }
    }
  } else {
    for (const root of ['/usr/lib/jvm', '/usr/java', '/opt/java']) {
      for (const name of safeDirs(root)) {
        out.push({ path: join(root, name, 'bin', EXE), source: 'scan' })
      }
    }
  }

  return out
}

/** PATH 里的 java 单独处理——它只是个名字，得靠 shell 解析。 */
function pathCandidates(): Candidate[] {
  const raw = process.env.PATH ?? ''
  const sep = isWindows ? ';' : ':'
  return raw
    .split(sep)
    .filter((p) => p !== '')
    .map((dir) => ({ path: join(dir, EXE), source: 'path' as const }))
}

function normalize(p: string): string {
  return isWindows ? p.toLowerCase() : p
}

/**
 * 扫描本机 Java。只探测真实存在且可执行的文件，去重后并行探测。
 *
 * 探测一个 JVM 要起一次进程（约 100–300 ms）。候选可能上百个，
 * 所以先用 existsSync 过滤，再做有限并发。
 */
export async function detectJava(opts: {
  readonly managedDir?: string
  readonly concurrency?: number
  readonly signal?: AbortSignal
}): Promise<JavaScanResult> {
  const seen = new Set<string>()
  const candidates: Candidate[] = []

  for (const c of [...candidatePaths(opts.managedDir), ...pathCandidates()]) {
    const key = normalize(c.path)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      if (!existsSync(c.path) || !statSync(c.path).isFile()) continue
    } catch {
      continue
    }
    candidates.push(c)
  }

  const installs: JavaInstall[] = []
  const rejected: { path: string; reason: string }[] = []
  const limit = Math.max(1, opts.concurrency ?? 4)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, candidates.length) }, async () => {
    for (;;) {
      const index = cursor++
      const c = candidates[index]
      if (c === undefined) return
      if (opts.signal?.aborted === true) return
      const probed = await probeJava(c.path, c.source)
      if (probed === null) rejected.push({ path: c.path, reason: '不是可用的 JVM' })
      else installs.push(probed)
    }
  })
  await Promise.all(workers)

  installs.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path))
  return { installs, rejected }
}
