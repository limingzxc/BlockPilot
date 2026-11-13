/**
 * 从版本 id 里剥出 MC 版本。
 *
 * `run` / `setup` 拿到的是命令行原始 id，可能是加载器版本
 * （`fabric-loader-0.20.1-1.6.4`、`1.20.1-forge-47.2.0`）。直接拿去判版本会落到
 * 「匹配不上 → 按新版本处理」，于是对 1.6.4 说「会崩在标题画面」，
 * 提示里的 `blockpilot assets fabric-loader-…` 也是错的（issue #18）。
 *
 * 只看形如 `1.<minor>[.<patch>]` 的整段：`fabric-loader-0.20.1-1.6.4` 里
 * 加载器版本 `0.20.1` 不是 MC 版本，跳过它取 `1.6.4`。
 */
export function gameVersionOf(id: string): string | undefined {
  for (const seg of id.split(/[-+]/)) {
    if (/^1\.\d+(?:\.\d+)?$/.test(seg)) return seg
  }
  return undefined
}
