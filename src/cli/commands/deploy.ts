import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createDeploy } from '../../core/deploy.js'
import { downloadOne } from '../../core/download/downloader.js'
import { runHint } from '../../core/hints.js'
import { detectHost } from '../../core/host.js'
import { readConfig } from '../../core/instance/config.js'
import type { Layout } from '../../core/layout.js'
import type { PackFileRead } from '../../core/preflight/read-pack.js'
import { readPackFile } from '../../core/preflight/read-pack.js'
import { safeJoin } from '../../core/safe-path.js'
import type { VersionInfo } from '../../core/sources.js'
import { resolveCurseforge } from '../../sources/curseforge.js'
import { MODRINTH_API_MCIM, ModrinthSource } from '../../sources/modrinth.js'
import type { CommandContext } from '../commands.js'
import { defineCommand } from '../commands.js'
import { CHINA, INSTANCE, ROOT } from '../common-flags.js'
import { SEVERITY_MARK, VERDICT_TEXT } from '../render/preflight.js'
import { pickJavaOrReport, positional } from '../shared.js'
import { C, consume, say } from '../ui.js'

export const cmdDeploy = defineCommand({
  name: 'deploy',
  positional: '<包|slug>',
  summary: '一次装完：原版 → 加载器 → 模组 → overrides；也可传 Modrinth slug',
  flags: {
    '--root': ROOT,
    '--instance': INSTANCE,
    '--china': CHINA,
    '--java': { takesValue: true, value: '<path>', help: '跑 Forge installer 用的 java' },
    '--no-cf-mirror': '禁用镜像回落，没 key 时只装加载器与 overrides',
    '--allow-host': {
      takesValue: true,
      value: '<host>',
      help: '额外允许的 mrpack 下载域名，逗号分隔（默认只允许 Modrinth 规范的域名）',
    },
    '--overwrite-overrides': '重跑时覆盖 overrides 里已存在的文件（会冲掉你改过的配置）',
  },
  notes: ['CurseForge 包不需要 key：没有 key 时走 MCIM 镜像逐个解析（ADR-0036）'],
  run: runDeploy,
})

/**
 * `deploy` 的 target 可以是本地包，也可以是 Modrinth 的 project slug。
 *
 * 判据：路径存在 → 本地；像 slug（字母数字/-/_）且不以 .mrpack/.zip 结尾 →
 * 去 Modrinth 取最新 release 的 mrpack，落到 `<root>/cache/packs/`。
 * 其他情况原样交给 createDeploy，让 `BAD_MODPACK` 带上用户输入的路径。
 */
async function resolvePackArg(
  target: string,
  layout: Layout,
  ctx: CommandContext,
): Promise<string | undefined> {
  if (existsSync(target)) return target
  if (
    target.includes('/') ||
    target.includes('\\') ||
    /\.(mrpack|zip)$/i.test(target) ||
    !/^[0-9A-Za-z][0-9A-Za-z_-]{1,63}$/.test(target)
  ) {
    return target
  }

  const source = new ModrinthSource(ctx.china ? { apiBase: MODRINTH_API_MCIM } : {})
  let info: VersionInfo | null
  try {
    info = await source.getLatestVersion(target, ctx.signal)
  } catch (err) {
    process.stderr.write(`${C.red}查询 Modrinth 失败${C.reset}: ${String(err)}\n`)
    return undefined
  }
  if (info === null) {
    process.stderr.write(
      `${C.red}Modrinth 上找不到${C.reset} ${target}\n` +
        `${C.dim}确认 slug；或直接传本地 .mrpack / .zip 路径${C.reset}\n`,
    )
    return undefined
  }

  const file =
    info.files.find((f) => f.primary && f.filename.toLowerCase().endsWith('.mrpack')) ??
    info.files.find((f) => f.filename.toLowerCase().endsWith('.mrpack')) ??
    info.files[0]
  if (file === undefined) {
    process.stderr.write(`${C.red}${info.name} 的最新版本没有可下载文件${C.reset}\n`)
    return undefined
  }

  // 文件名来自 API；只取 basename，并确认落点仍在 cache/packs 下
  const fileName = basename(file.filename)
  const dest = safeJoin(join(layout.root, 'cache', 'packs'), fileName)
  if (dest === null) {
    process.stderr.write(`${C.red}Modrinth 返回的文件名不安全${C.reset}: ${file.filename}\n`)
    return undefined
  }
  process.stderr.write(
    `${C.dim}· Modrinth ${info.name} · ${info.versionId} → ${fileName}${C.reset}\n`,
  )
  try {
    await downloadOne(
      {
        url: file.url,
        fileName,
        destPath: dest,
        expectedSize: file.size,
        hashes: file.hashes,
      },
      ctx.sources,
      ctx.signal,
    )
  } catch (err) {
    process.stderr.write(`${C.red}下载整合包失败${C.reset}: ${String(err)}\n`)
    return undefined
  }
  return dest
}

export async function runDeploy(ctx: CommandContext): Promise<number> {
  let packPath = positional(ctx)
  if (packPath === undefined) {
    ctx.usage()
    return 1
  }
  const layout = ctx.layout
  const china = ctx.china
  const instance = layout.instanceId

  const resolved = await resolvePackArg(packPath, layout, ctx)
  if (resolved === undefined) return 1
  packPath = resolved

  say('\n')
  say(`  ${C.dim}整合包${C.reset}  ${packPath}\n`)
  say(`  ${C.dim}实例${C.reset}    ${instance} → ${layout.gameDir}\n\n`)

  // 部署后自检要判 Java。检测会起若干次 JVM 进程（1–3 秒），相比后面几分钟的
  // 下载可以忽略；省掉它的代价是自检看不见 Java 不对，装完打「通过」再崩
  const host = await detectHost({ root: layout.root })

  // Forge 要跑 installer，得有 java。Fabric 用不到，但先检测一次省得后续分支判断。
  // 必须把包里的游戏版本传进去：26.2 要 Java 25，不知道版本就只能「捡最高的那个用」，
  // 机器上只有 Java 8 时也会被当成可用，Forge installer 随后炸得莫名其妙。
  let pack: PackFileRead | undefined
  let packGameVersion: string | undefined
  let packLoaderKind: string | undefined
  try {
    pack = readPackFile(packPath)
    packGameVersion = pack.instance.gameVersion
    packLoaderKind = pack.instance.loader.kind
  } catch {
    // 包本身读不出来由 createDeploy 报 BAD_MODPACK，这里不抢它的活
  }
  // 只有 Forge / NeoForge 要 java；对 Quilt 说「没找到可用的 Java」会让人以为装不了
  const needsJava = packLoaderKind === 'forge' || packLoaderKind === 'neoforge'
  const config = readConfig(layout.gameDir)
  const javaPath = needsJava
    ? await pickJavaOrReport(
        packGameVersion,
        layout,
        ctx.signal,
        ctx.value('--java') ?? config.javaPath,
      )
    : undefined

  const allowHosts = (ctx.value('--allow-host') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '')
  const op = createDeploy({
    packPath,
    ...(pack === undefined ? {} : { pack }),
    layout,
    sources: ctx.sources,
    mirror: china,
    host,
    ...(allowHosts.length === 0 ? {} : { allowHosts }),
    ...(ctx.has('--overwrite-overrides') ? { overwriteOverrides: true } : {}),
    ...(javaPath === undefined ? {} : { java: javaPath }),
    ...(ctx.proxy === undefined ? {} : { proxy: ctx.proxy }),
    // key 只从环境变量读（ADR-0029）：命令行参数会留在 shell history 里
    curseforge: resolveCurseforge(ctx.has('--no-cf-mirror') ? { allowMirror: false } : {}),
  })

  return consume(
    op,
    {
      progress: (ev) => {
        process.stderr.write(`\r${C.dim}${ev.done}/${ev.total}  ${ev.label}${C.reset}          `)
        if (ev.done === ev.total) process.stderr.write('\r')
      },
      log: (ev) => {
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
        } else if (ev.code === 'deploy.ok') {
          process.stderr.write(
            `  ${C.green}↓${C.reset} ${ev.data.file}  ${C.dim}${ev.data.source}${C.reset}\n`,
          )
        } else if (ev.code === 'deploy.failed') {
          process.stderr.write(`  ${C.red}✗${C.reset} ${ev.data.file}  ${ev.data.error}\n`)
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
        say(`    ${runHint(r.playableVersionId, layout.root, instance)}\n\n`)
      },
      failed: (ev) => {
        process.stderr.write(`\n${C.red}${ev.code}${C.reset}: ${ev.message}\n`)
        if (ev.hint !== undefined) process.stderr.write(`${C.dim}${ev.hint}${C.reset}\n`)
      },
    },
    ctx.signal,
  )
}
