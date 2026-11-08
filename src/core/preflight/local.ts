import { checkLocalDeps } from '../deps/localDeps.js'
import type { ScanResult } from '../instance/scan.js'
import type { Finding } from './types.js'

/**
 * 离线检查一个实例目录。
 *
 * 与在线预检的区别：没有 projectId，给不出下载地址，但能做版本比对——
 * `minecraft` / `fabricloader` 的约束是靠实例的版本信息（而不是 mod 元数据）判定的。
 *
 * 逻辑抽在这里而不是内联在 preflight 里，是因为 `deploy` 装完也要跑同一套检查。
 */
export function checkLocalInstance(
  scan: ScanResult,
  ctx: { readonly gameVersion: string; readonly loaderVersion: string },
): readonly Finding[] {
  const findings: Finding[] = []

  const issues = checkLocalDeps(
    scan.mods.map((m) => ({
      modId: m.meta.modId,
      version: m.meta.version,
      dependencies: m.meta.dependencies,
      provides: m.meta.provides,
      nested: m.meta.nested,
      loader: m.meta.loader,
    })),
    { gameVersion: ctx.gameVersion, loaderVersion: ctx.loaderVersion },
  )

  for (const issue of issues) {
    if (issue.kind === 'version') {
      findings.push({
        severity: 'blocker',
        code: 'DEPENDENCY_VERSION_MISMATCH',
        message:
          `${issue.requiredBy.join('、')} 要求 ${issue.modId} ${issue.requiredRange ?? ''}，` +
          `实际是 ${issue.actualVersion ?? '未知'}`,
        subject: issue.modId,
        hint:
          issue.modId === 'fabricloader'
            ? '加载器版本太低，换更高的 loader 版本重装'
            : issue.modId === 'minecraft'
              ? '模组不支持当前 MC 版本'
              : '换一个满足版本要求的模组',
      })
      continue
    }
    findings.push({
      severity: 'blocker',
      code: 'MISSING_DEPENDENCY',
      message: `${issue.requiredBy.join('、')} 需要前置模组 ${issue.modId}，本地目录里没有`,
      subject: issue.modId,
      hint: '本地元数据只提供 modId，没有下载地址；需要联网反查才能给出可安装版本',
    })
  }

  if (scan.corrupt.length > 0) {
    findings.push({
      severity: 'warning',
      code: 'CORRUPT_JAR',
      message: `${scan.corrupt.length} 个 jar 已损坏（不是完整的压缩包），游戏会因此启动失败`,
      subject: scan.corrupt[0],
      hint: `删掉重下：${scan.corrupt.slice(0, 5).join('、')}${
        scan.corrupt.length > 5 ? ' 等' : ''
      }。用 blockpilot install 装的文件会校验 sha1，一般不会出现这种情况`,
    })
  }

  // 范围是 skipped 里「没坏、只是没有可识别元数据」的那部分。
  // 这类文件是正常的（资源包、把老库改名成 .jar），报 warning 只会制造噪音。
  const noMeta = scan.skipped.filter((f) => !scan.corrupt.includes(f))
  if (noMeta.length > 0) {
    findings.push({
      severity: 'info',
      code: 'UNREADABLE_JAR',
      message: `${noMeta.length} 个 jar 里没有可识别的模组元数据，未参与检查`,
      hint: `${noMeta.slice(0, 5).join('、')}${noMeta.length > 5 ? ' 等' : ''}。资源包/非模组 jar 属于正常情况`,
    })
  }

  if (ctx.gameVersion === 'unknown') {
    findings.push({
      severity: 'warning',
      code: 'UNKNOWN_GAME_VERSION',
      message: '目录里没有版本信息，无法校验 MC 版本与 Java',
      hint: 'Prism/MultiMC 实例的 mmc-pack.json 可提供；否则需要显式指定',
    })
  }

  return findings
}
