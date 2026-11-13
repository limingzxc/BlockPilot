import type { Finding, PreflightReport } from '../../core/preflight/types.js'
import { C, humanBytes } from '../output/ansi.js'

export const SEVERITY_MARK: Record<Finding['severity'], string> = {
  blocker: `${C.red}✗${C.reset}`,
  warning: `${C.yellow}!${C.reset}`,
  info: `${C.cyan}i${C.reset}`,
}

export const VERDICT_TEXT: Record<PreflightReport['verdict'], string> = {
  ok: `${C.green}OK${C.reset}`,
  warn: `${C.yellow}WARN${C.reset}`,
  blocked: `${C.red}BLOCKED${C.reset}`,
  unknown: `${C.yellow}UNKNOWN${C.reset}`,
}

/**
 * verdict → 退出码。
 *
 * `unknown` 给 0 是有意的：它的意思是「没验到」，不是「验出问题」。
 * 这条契约在 E2E-004「unknown 不能当违规」里钉死了——把「没证据」当成
 * 失败，会让离线场景（模组元数据拿不到）下正常实例全都报错。
 *
 * 代价是脚本无法只靠退出码区分「验过且通过」和「什么都没验到」，
 * 需要区分时用 `--json` 读 verdict 字段。
 */
export function verdictExit(verdict: PreflightReport['verdict']): number {
  switch (verdict) {
    case 'ok':
    case 'warn':
    case 'unknown':
      return 0
    case 'blocked':
      return 2
  }
}

export function renderHuman(r: PreflightReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push(`${C.bold}BlockPilot preflight${C.reset}`)
  lines.push('')
  if (r.target !== undefined) {
    const loader =
      r.target.loader.kind === 'vanilla'
        ? ''
        : ` + ${r.target.loader.kind} ${r.target.loader.version}`
    lines.push(`  目标      ${r.target.gameVersion}${loader}`)
  }
  lines.push(`  verdict   ${VERDICT_TEXT[r.verdict]}`)
  lines.push(
    `  mods      ${r.stats.mods}  ${C.dim}(resolved ${r.stats.resolved}, unresolved ${r.stats.unresolved})${C.reset}`,
  )
  lines.push('')

  // 「指错目录」是最常见的误用，而这个提示只有在 findings 之外才不会被挤掉：
  // 多套一层目录时往往同时伴随 UNKNOWN_GAME_VERSION，一旦进了 else 分支就再也看不见。
  if (r.stats.mods === 0) {
    lines.push(`  ${C.yellow}没有可检查的模组${C.reset}`)
    lines.push(
      `  ${C.dim}没有在 mods/ 下读到任何模组。如果包里确实有模组，检查 path 是不是多套了一层目录${C.reset}`,
    )
    lines.push('')
  }

  if (r.findings.length === 0) {
    // 「没有发现问题」是一个结论。没东西可查、或者什么都没查成的时候，
    // 说这句话等于给了一个假的通过——用户会跳过后面所有步骤。
    if (r.stats.mods > 0) {
      if (r.verdict === 'unknown') {
        lines.push(`  ${C.yellow}这次没有验成${C.reset}`)
        lines.push(`  ${C.dim}模组元数据没取到，不代表包没问题${C.reset}`)
      } else {
        lines.push(`  ${C.green}没有发现问题${C.reset}`)
      }
    }
    lines.push('')
  } else {
    const order: Finding['severity'][] = ['blocker', 'warning', 'info']
    for (const sev of order) {
      const group = r.findings.filter((f) => f.severity === sev)
      for (const f of group) {
        lines.push(`  ${SEVERITY_MARK[f.severity]} ${C.bold}${f.code}${C.reset}  ${f.message}`)
        if (f.hint !== undefined) lines.push(`    ${C.dim}→ ${f.hint}${C.reset}`)
        if (f.subject !== undefined) lines.push(`    ${C.dim}subject: ${f.subject}${C.reset}`)
        lines.push('')
      }
    }
  }

  if (r.plan.installs.length > 0) {
    lines.push(`${C.bold}修复计划${C.reset}`)
    lines.push('')
    for (const p of r.plan.installs) {
      const uncertain = p.confidence === 'unverified'
      const mark = uncertain ? `${C.yellow}?${C.reset}` : `${C.green}+${C.reset}`
      lines.push(
        `  ${mark} ${p.displayName}  ${C.dim}${p.fileName} · ${humanBytes(p.size)}${C.reset}`,
      )
      lines.push(
        `    ${C.dim}被 ${p.requiredBy.join('、')} 依赖 · ${p.projectId}/${p.versionId}${C.reset}` +
          (uncertain ? `  ${C.yellow}未验证：可能已被某个模组内置${C.reset}` : ''),
      )
    }
    lines.push('')
  }

  if (r.plan.manual.length > 0) {
    lines.push(`${C.bold}需要人工处理${C.reset}`)
    lines.push('')
    for (const m of r.plan.manual) {
      const why =
        m.reason === 'no-compatible-version'
          ? '找不到兼容当前游戏版本与加载器的版本'
          : '该版本没有可下载文件'
      // 名字给人看，id 留给搜索与脚本
      const label = m.displayName === undefined ? m.projectId : `${m.displayName} (${m.projectId})`
      lines.push(`  ${C.yellow}?${C.reset} ${label}  ${C.dim}${why}${C.reset}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
