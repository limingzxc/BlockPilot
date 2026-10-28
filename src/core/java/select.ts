/**
 * 「为这个版本挑一个 Java」的用例（架构评审候选 4）。
 *
 * 此前这个用例只活在 CLI 里：runLaunch 与 runGame 各复制 17 行，
 * runDeploy 又是一个变体（按 major 降序取第一个）。core 有 detectJava /
 * pickJava / requiredJavaMajor 三个深模块，但没有人把它们组合成用例——
 * 于是复制品之间开始行为漂移。
 *
 * 现在用例在这里，CLI 只渲染结局。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { detectJava } from './detect.js'
import { pickJava, requiredJavaMajor } from './types.js'
import type { JavaInstall, JavaScanResult } from './types.js'

export type SelectJavaOutcome =
  | {
      readonly ok: true
      /** java 可执行文件路径——调用方真正需要的那一个字段 */
      readonly path: string
      /** 探测到的完整信息。用户显式指定路径时没有 */
      readonly install?: JavaInstall
      /** 有版本要求时的目标大版本；按「最高版本兜底」选时为 undefined */
      readonly needMajor?: number
    }
  | {
      readonly ok: false
      /** 人话错误，CLI 直接打印 */
      readonly message: string
      readonly needMajor?: number
      readonly foundMajors: readonly number[]
    }

/**
 * 纯函数：在已扫描到的运行时里选一个。
 *
 * - 给了 `needMajor`：交给 pickJava（精确优先、managed 优先、其次更高）
 * - 没给：取最高版本——没版本要求时，最新的是最不会缺新 API 的
 */
export function chooseJava(
  installs: readonly JavaInstall[],
  needMajor: number | undefined,
): JavaInstall | null {
  if (needMajor !== undefined) return pickJava(installs, needMajor)
  return [...installs].sort((a, b) => b.major - a.major)[0] ?? null
}

export interface SelectJavaOptions {
  /** 已解析的版本 id（如 1.20.1、fabric-loader-…-1.20.1）。不给就按最高版本兜底 */
  readonly versionId?: string
  readonly layoutRoot: string
  readonly signal?: AbortSignal
  /** 用户显式指定的路径，直接通过 */
  readonly explicit?: string
  /** 测试注入：跳过真实探测 */
  readonly scan?: (opts: { signal?: AbortSignal; managedDir: string }) => Promise<JavaScanResult>
}

export async function selectJava(opts: SelectJavaOptions): Promise<SelectJavaOutcome> {
  if (opts.explicit !== undefined) {
    // 显式路径优先，但不能假装它存在：直接 spawn 的话，用户看到的是
    // 「spawn ENOENT + 异常退出」，被引导去 diag 一份 0 行的日志。
    if (!existsSync(opts.explicit)) {
      return { ok: false, message: `指定的 Java 不存在：${opts.explicit}`, foundMajors: [] }
    }
    return { ok: true, path: opts.explicit }
  }

  const needMajor = opts.versionId === undefined ? undefined : requiredJavaMajor(opts.versionId)
  const managedDir = join(opts.layoutRoot, 'java')
  const scanFn = opts.scan ?? detectJava
  const scan = await scanFn({
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    managedDir,
  })

  const foundMajors = scan.installs.map((j) => j.major)
  const picked = chooseJava(scan.installs, needMajor)
  if (picked === null) {
    const need = needMajor === undefined ? '' : ` Java ${needMajor}`
    return {
      ok: false,
      message: `没有找到可用的 Java${need}（本机：${foundMajors.join(', ') || '无'}）`,
      ...(needMajor === undefined ? {} : { needMajor }),
      foundMajors,
    }
  }
  return {
    ok: true,
    path: picked.path,
    install: picked,
    ...(needMajor === undefined ? {} : { needMajor }),
  }
}
