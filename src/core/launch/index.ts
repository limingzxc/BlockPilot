import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import type { Layout } from '../layout.js'
import { fetchVersionJson } from '../version/fetch.js'
import { resolveVersion } from '../version/resolve.js'
import { detectEnv } from './env.js'
import { buildLaunchPlan } from './plan.js'
import type { LaunchPlan } from './plan.js'

export interface LaunchOptions {
  readonly versionId: string
  readonly layout: Layout
  readonly java: string
  readonly username?: string
  readonly maxMemoryMiB?: number
  /** 走 BMCLAPI 拉版本 JSON */
  readonly mirror?: boolean
}

export function createLaunchPlan(opts: LaunchOptions): Operation<LaunchPlan> {
  return defineOperation<LaunchPlan>('launch-plan', async function* (signal) {
    const env = detectEnv()
    yield Op.log('info', 'launch.env', env)

    yield Op.log('info', 'launch.version.fetch', { versionId: opts.versionId })
    // 走 resolveVersion 而不是 fetchVersionJson：
    // 加载器版本只存在于本地 versions/<id>/<id>.json，还要沿 inheritsFrom 合并
    const resolved = await resolveVersion(opts.versionId, {
      layout: opts.layout,
      ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
      signal,
    })
    const version = resolved.json

    yield Op.log('info', 'launch.version.loaded', {
      id: version.id,
      rootId: resolved.rootId,
      type: version.type,
      libraries: version.libraries.length,
      hasModernArgs: version.arguments !== undefined,
      javaMajorVersion: version.javaVersion?.majorVersion,
    })

    const plan = buildLaunchPlan({
      java: opts.java,
      layout: opts.layout,
      version,
      rootVersionId: resolved.rootId,
      env,
      username: opts.username ?? 'Player',
      ...(opts.maxMemoryMiB === undefined ? {} : { maxMemoryMiB: opts.maxMemoryMiB }),
    })

    yield Op.log('info', 'launch.plan.ready', {
      mainClass: plan.mainClass,
      classpathEntries: plan.classpath.length,
      missing: plan.missing.length,
    })

    yield Op.result(plan)
    yield Op.done()
  })
}
