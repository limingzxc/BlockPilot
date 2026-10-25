import { Op } from '../events.js'
import { defineOperation } from '../operation.js'
import type { Operation } from '../operation.js'
import type { Layout } from '../layout.js'
import { fetchVersionJson } from '../version/fetch.js'
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
    const version = await fetchVersionJson(opts.versionId, {
      ...(opts.mirror === undefined ? {} : { mirror: opts.mirror }),
      signal,
    })

    yield Op.log('info', 'launch.version.loaded', {
      id: version.id,
      type: version.type,
      libraries: version.libraries.length,
      hasModernArgs: version.arguments !== undefined,
      javaMajorVersion: version.javaVersion?.majorVersion,
    })

    const plan = buildLaunchPlan({
      java: opts.java,
      layout: opts.layout,
      version,
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
