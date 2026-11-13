/**
 * `deploy` 的渲染：命令头、错误、事件流与结果。
 *
 * 这里不装配任何东西（host / pack / java / sources 都在 use-cases/deploy.ts），
 * 只把 DeployResult 与 OpEvent 翻译成人类可读文本。
 */

import type { DeployResult } from '../../core/deploy/index.js'
import type { OpEvent } from '../../core/events/index.js'
import { runHint } from '../../core/hints.js'
import type { Layout } from '../../core/layout.js'
import { C } from '../output/ansi.js'
import { say } from '../output/stream.js'
import { downloadRenderer } from './download.js'
import { SEVERITY_MARK, VERDICT_TEXT } from './preflight.js'

type ProgressEvent = Extract<OpEvent<never>, { type: 'progress' }>
type LogEvent = Extract<OpEvent<never>, { type: 'log' }>
type FailedEvent = Extract<OpEvent<never>, { type: 'failed' }>

export interface DeployIntro {
  readonly packPath: string
  readonly instance: string
  readonly gameDir: string
  readonly remote?: {
    readonly name: string
    readonly versionId: string
    readonly fileName: string
  }
}

export function renderDeployIntro(intro: DeployIntro): void {
  if (intro.remote !== undefined) {
    process.stderr.write(
      `${C.dim}· Modrinth ${intro.remote.name} · ${intro.remote.versionId} → ${intro.remote.fileName}${C.reset}\n`,
    )
  }
  say('\n')
  say(`  ${C.dim}整合包${C.reset}  ${intro.packPath}\n`)
  say(`  ${C.dim}实例${C.reset}    ${intro.instance} → ${intro.gameDir}\n\n`)
}

export function renderDeployFailure(message: string, hint?: string): void {
  process.stderr.write(`${C.red}${message}${C.reset}\n`)
  if (hint !== undefined) process.stderr.write(`${C.dim}${hint}${C.reset}\n`)
}

export interface DeployUi {
  progress(ev: ProgressEvent): void
  log(ev: LogEvent): void
  failed(ev: FailedEvent): void
  result(value: DeployResult): void
  exitCode(value: DeployResult): number
}

export function deployUi(opts: { readonly layout: Layout; readonly instance: string }): DeployUi {
  const downloads = downloadRenderer({
    ok: 'deploy.ok',
    cached: 'deploy.cached',
    failed: 'deploy.failed',
  })

  return {
    progress: downloads.progress,
    log: (ev) => {
      if (ev.code === 'deploy.ok' || ev.code === 'deploy.cached' || ev.code === 'deploy.failed') {
        downloads.log(ev)
        return
      }
      if (ev.code === 'deploy.pack') {
        process.stderr.write(`${C.bold}${ev.data.name}${C.reset}\n`)
      } else if (ev.code === 'deploy.step') {
        const label: Record<typeof ev.data.step, string> = {
          vanilla: '原版文件',
          loader: '加载器',
          files: '整合包文件',
          overrides: 'overrides',
          check: '部署后检查',
        }
        process.stderr.write(`${C.cyan}→${C.reset} ${label[ev.data.step]}\n`)
      } else if (ev.code === 'deploy.cf_source') {
        process.stderr.write(`${C.dim}· CurseForge 解析源：${ev.data.source}${C.reset}\n`)
      } else if (ev.code === 'deploy.pack_changed') {
        process.stderr.write(
          `\n${C.yellow}!${C.reset} 这个实例之前装的是 ${ev.data.from}，现在是 ${ev.data.to}\n` +
            `${C.dim}  旧包的 ${ev.data.previousFiles} 个文件不会自动删除；先清空 mods/ 再启动，` +
            `否则新旧模组会混在一起${C.reset}\n\n`,
        )
      } else if (ev.code === 'deploy.cf_no_key') {
        process.stderr.write(
          `\n${C.yellow}!${C.reset} 没有 BLOCKPILOT_CF_API_KEY：清单里的 ${ev.data.files} 个文件装不了，` +
            `先装加载器与 overrides\n` +
            `${C.dim}  key 在 console.curseforge.com 免费申请；设好环境变量后重跑同一条命令，已下的会跳过${C.reset}\n\n`,
        )
      }
    },
    exitCode: (r) => (r.check.verdict === 'blocked' || r.failed.length > 0 ? 2 : 0),
    result: (r) => {
      say('\n')
      say(`  ${C.green}装好了${C.reset}  ${r.gameVersion} + ${r.loaderKind} ${r.loaderVersion}\n`)
      say(
        `  ${C.dim}模组 ${r.mods} 个（文件 ${r.files} 个：下载 ${r.modsDownloaded} / 跳过 ${r.modsSkipped} / 失败 ${r.failed.length}）· ` +
          `overrides ${r.overrides} 个文件` +
          (r.overridesSkipped > 0 ? `（${r.overridesSkipped} 个已存在，未覆盖）` : '') +
          `${r.overridesMods > 0 ? `（其中 mods/ 里 ${r.overridesMods} 个 jar）` : ''}${C.reset}\n`,
      )

      // 部署后自检：装在完 ≠ 能跑
      say('\n')
      say(`  ${C.bold}部署后检查${C.reset}  ${VERDICT_TEXT[r.check.verdict]}\n`)
      const notable = r.check.findings.filter((f) => f.severity !== 'info')
      if (notable.length === 0) {
        // unknown 不能跟着「没有发现阻塞项」一起说：那是「没检查到」，不是「没问题」
        say(
          r.check.verdict === 'unknown'
            ? `    ${C.dim}有 ${r.check.stats.unresolved} 个文件没参与检查，这个结论不可信${C.reset}\n`
            : `    ${C.dim}没有发现阻塞项${C.reset}\n`,
        )
      } else {
        for (const f of notable) {
          say(`    ${SEVERITY_MARK[f.severity]} ${C.bold}${f.code}${C.reset}  ${f.message}\n`)
          if (f.hint !== undefined) say(`      ${C.dim}→ ${f.hint}${C.reset}\n`)
        }
      }

      say('\n')
      if (r.check.verdict === 'blocked') {
        say(`  ${C.yellow}先别启动${C.reset}，上面这些会直接导致崩溃\n\n`)
        return
      }
      say(`  ${C.bold}启动${C.reset}\n`)
      say(`    ${runHint(r.playableVersionId, opts.layout.root, opts.instance)}\n\n`)
    },
    failed: (ev) => {
      process.stderr.write(`\n${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
      if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
    },
  }
}
