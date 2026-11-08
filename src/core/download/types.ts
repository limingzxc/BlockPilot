/** 一个可以落地的下载任务。字段来自 RepairPlan.installs，加上目标路径。 */
export interface DownloadTask {
  readonly url: string
  readonly fileName: string
  /** 绝对路径 */
  readonly destPath: string
  readonly expectedSize: number
  /** 至少要有 sha1。没有哈希的任务不允许下载——无法验证来源。 */
  readonly hashes: Readonly<Record<string, string>>
}

export interface SourceAttempt {
  readonly source: string
  readonly ok: boolean
  readonly error?: string
}

export interface DownloadOutcome {
  readonly fileName: string
  readonly bytes: number
  /** 实际生效的源。跳过已存在文件时为 'cache' */
  readonly source: string
  /** 该源的展示署名。BMCLAPI 协议要求标明来源，这里必须能透传到 UI。 */
  readonly credit?: string
  /** 服务器的最终落点。镜像 302 回官方时能从这里看出来。 */
  readonly finalUrl?: string
  readonly skipped: boolean
  /**
   * 下载成功但字节数与索引里的 `expectedSize` 不一致。
   *
   * 不是失败：哈希已经对上了，内容就是它。这是索引元数据的漂移
   * （Modrinth 上确实存在差 1 字节的条目），调用方最多提示一句。
   */
  readonly sizeMismatch?: boolean
  readonly attempts: readonly SourceAttempt[]
}

export interface InstallResult {
  readonly downloaded: readonly DownloadOutcome[]
  readonly failed: readonly { readonly fileName: string; readonly error: string }[]
  readonly totalBytes: number
  readonly installedDir: string
}

/**
 * 下载源。
 *
 * `rewrite` 返回 null 表示「这个源不覆盖该 URL」——调用方会静默跳过，不算失败。
 * 直连源必须返回原 URL 而不是 null，否则它永远不会被使用。
 *
 * `credit` 不是装饰。BMCLAPI 的协议明确要求「所有使用 BMCLAPI 的程序
 * 必需在下载界面或其他可视部分标明来源」，所以它必须能被渲染出来。
 */
export interface DownloadSource {
  readonly name: string
  readonly credit: string
  rewrite(url: URL): string | null
}
