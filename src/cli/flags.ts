/**
 * 子命令的 flag 形状与校验。
 *
 * 单独成文件是为了能被测试 import：`index.ts` 顶层就会执行 main()，
 * 测试没法从那里取任何东西。hints 的可执行性测试依赖这张表。
 */

/**
 * 每个子命令接受的 flag。`true` 表示这个 flag 后面必须跟一个值。
 *
 * 为什么要这张表：以前未知参数被静默忽略，`--json` 拼成 `--jsno` 依然退出 0，
 * 脚本拿到一段人类可读文本去 JSON.parse，错在别处；`--root` 忘了写路径则
 * 悄悄装进默认目录。**静默做错事比报错难查得多。**
 */
export const COMMAND_FLAGS: Record<string, Readonly<Record<string, boolean>>> = {
  preflight: { '--json': false, '--no-host': false, '--no-cf-mirror': false },
  install: {
    '--mods-dir': true,
    '--dry-run': false,
    '--include-unverified': false,
    '--no-host': false,
    '--china': false,
  },
  java: { '--root': true, '--china': false },
  login: { '--root': true, '--client-id': true },
  accounts: { '--root': true, '--remove': true },
  setup: { '--root': true, '--instance': true, '--dry-run': false, '--china': false },
  assets: { '--root': true, '--dry-run': false, '--china': false, '--concurrency': true },
  fabric: {
    '--root': true,
    '--instance': true,
    '--loader': true,
    '--china': false,
    // 1.6.x / 1.7.10 / 1.12.2 只有 Legacy Fabric 有 loader；缺省自动探测
    '--legacy': false,
  },
  deploy: {
    '--root': true,
    '--instance': true,
    '--china': false,
    '--java': true,
    // 有 key 走官方批量接口；没有就走 MCIM 镜像（默认），--no-cf-mirror 关掉回落
    '--curseforge-key': true,
    '--no-cf-mirror': false,
  },
  launch: {
    '--root': true,
    '--instance': true,
    '--raw': false,
    '--java': true,
    '--memory': true,
    '--user': true,
    '--china': false,
    '--account': true,
    '--offline': false,
  },
  run: {
    '--root': true,
    '--instance': true,
    '--quiet': false,
    '--stop': true,
    '--java': true,
    '--memory': true,
    '--user': true,
    '--china': false,
    '--account': true,
    '--offline': false,
  },
  forge: { '--root': true, '--instance': true, '--loader': true, '--java': true, '--china': false },
  neoforge: { '--root': true, '--instance': true, '--loader': true, '--java': true, '--china': false },
  logs: { '--root': true, '--instance': true },
  diag: { '--root': true, '--instance': true, '--file': true, '--json': false },
}

/** 找第一个不认识的 flag，或需要值却没给值的 flag。返回人话，没问题返回 undefined。 */
export function validateFlags(
  args: readonly string[],
  spec: Readonly<Record<string, boolean>>,
): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (a === undefined || !a.startsWith('--')) continue

    const needsValue = spec[a]
    if (needsValue === undefined) return `未知参数 ${a}`
    if (!needsValue) continue

    const value = args[i + 1]
    // 值不能是另一个 flag：`--root --china` 是少写了路径，不是要把 root 设成 "--china"
    if (value === undefined || value.startsWith('--')) return `${a} 需要一个值`
    i += 1
  }
  return undefined
}
