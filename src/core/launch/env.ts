import type { LaunchEnv, OsArch, OsName } from '../launch-env.js'
import type { Rule } from '../version/types.js'

export function detectEnv(platform: NodeJS.Platform = process.platform): LaunchEnv {
  const os: OsName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
  const arch: OsArch = process.arch === 'x64' ? 'x86_64' : process.arch === 'ia32' ? 'x86' : 'arm64'
  return {
    os,
    arch,
    ...(os === 'windows' ? { osVersion: '10.0' } : {}),
    features: { has_custom_resolution: false, is_demo_user: false, has_quick_plays_support: false },
  }
}

function ruleMatches(rule: Rule, env: LaunchEnv): boolean {
  if (rule.os !== undefined) {
    if (rule.os.name !== undefined && rule.os.name !== env.os) return false
    if (rule.os.arch !== undefined && rule.os.arch !== env.arch) return false
    if (rule.os.version !== undefined) {
      try {
        if (!new RegExp(rule.os.version).test(env.osVersion ?? '')) return false
      } catch {
        // 正则本身写错了：这条规则不匹配，不让它影响整体判断
        return false
      }
    }
  }
  if (rule.features !== undefined) {
    for (const [key, expected] of Object.entries(rule.features)) {
      if ((env.features[key] ?? false) !== expected) return false
    }
  }
  return true
}

/**
 * Mojang 的规则语义：默认不允许，逐条匹配，**最后一条匹配的规则生效**。
 *
 * 注意是「最后一条」而不是「任意一条 allow」——顺序有意义。
 */
export function rulesAllow(rules: readonly Rule[] | undefined, env: LaunchEnv): boolean {
  if (rules === undefined || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (!ruleMatches(rule, env)) continue
    allowed = rule.action === 'allow'
  }
  return allowed
}
