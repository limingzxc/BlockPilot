/**
 * 部署后自检与已装清单。
 *
 * 这两个动作共用同一份磁盘事实（实例目录 + lock），放在一起；
 * 编排层只负责决定「什么时候调用」以及把失败转成事件。
 */
import type { DownloadTask } from '../download/types.js'
import { errMessage } from '../errors.js'
import { writeInstanceIdentity } from '../instance/identity.js'
import { buildLock, toLockedFile, writeLock } from '../instance/lock.js'
import { scanInstanceDir } from '../instance/scan.js'
import type { HostProfile, LoaderRef } from '../instance.js'
import type { Layout } from '../layout.js'
import type { ReportStats } from '../preflight/report.js'
import { preflightDir } from '../preflight/report.js'
import type { Finding, Verdict } from '../preflight/types.js'
import { readAssetIndexId, readJavaMajor } from '../version/java-major.js'

export interface PostCheckInput {
  readonly layout: Layout
  readonly gameVersion: string
  readonly loader: LoaderRef
  readonly host?: HostProfile
  readonly tasks: readonly DownloadTask[]
  readonly lock: {
    readonly packName: string
    readonly packKind: 'mrpack' | 'curseforge'
    readonly packFile: string
    readonly complete: boolean
  }
}

export interface PostCheckResult {
  readonly check: {
    readonly verdict: Verdict
    readonly findings: readonly Finding[]
    readonly stats: ReportStats
  }
  /** 写失败时没有这个字段 */
  readonly lockPath?: string
  /** lock 写失败不阻断部署，但必须让调用方把原因说出来 */
  readonly lockError?: string
}

export function runPostCheck(input: PostCheckInput): PostCheckResult {
  // 先写版本标记，再自检：这样自检走的是「和用户 preflight 完全一样」的路径，
  // 而不是靠 fallback 参数凑出来的版本号
  writeInstanceIdentity(input.layout.gameDir, {
    gameVersion: input.gameVersion,
    loader: { kind: input.loader.kind, version: input.loader.version },
  })
  const scan = scanInstanceDir(input.layout.gameDir, {
    fallbackGameVersion: input.gameVersion,
    fallbackLoader: input.loader,
  })

  /**
   * 自检不自己拼 findings：和 `preflight <实例目录>` 调同一个 module。
   *
   * 手抄会漏：只查模组与 assets 就漏掉 Java，也没有「有东西没校验到就不算 ok」
   * 那条规则，于是自检说通过、run 说崩（ADR-0037）。
   */
  // 版本 JSON 的 javaVersion 是权威值；读不到再退回 gameVersion 查表。
  // assetIndex.id 同理：现代版本的 index 叫 5 / 17 / 32，不能按 MC 版本猜。
  const versionJson = input.layout.versionJson(input.gameVersion)
  const javaMajor = readJavaMajor(versionJson)
  const assetIndexId = readAssetIndexId(versionJson)
  const check = preflightDir({
    dir: input.layout.gameDir,
    scan,
    // 资源装在 <root>/assets，不在实例目录里
    assetsDir: input.layout.assets,
    ...(input.host === undefined ? {} : { host: input.host }),
    ...(javaMajor === undefined ? {} : { javaMajor }),
    ...(assetIndexId === undefined ? {} : { assetIndexId }),
  })

  const lockedFiles = input.tasks.map((t) => toLockedFile(t, input.layout.gameDir))
  let lockPath: string | undefined
  let lockError: string | undefined
  try {
    lockPath = writeLock(
      input.layout.gameDir,
      buildLock({
        packName: input.lock.packName,
        packKind: input.lock.packKind,
        packFile: input.lock.packFile,
        gameVersion: input.gameVersion,
        loader: input.loader,
        complete: input.lock.complete,
        files: lockedFiles,
      }),
    )
  } catch (err) {
    // 清单写不下去不影响本次安装，但 verify / update 会缺前置：必须说出来
    lockError = errMessage(err)
  }

  return {
    check: { verdict: check.verdict, findings: check.findings, stats: check.stats },
    ...(lockPath === undefined ? {} : { lockPath }),
    ...(lockError === undefined ? {} : { lockError }),
  }
}
