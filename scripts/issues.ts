/**
 * GitHub issue 的读写。替代 `gh`（这台机器上没装）。
 *
 * 为什么是脚本而不是手敲 REST：
 * - 本机 `github.com:443` 可能被拦，但 `api.github.com` 可用；curl 还能走本地代理，
 *   `BLOCKPILOT_PROXY` 改地址，默认 http://127.0.0.1:53179。
 * - token 从 GITHUB_TOKEN 或 `git credential fill` 取，不落盘、不回显。
 *
 * 用法：
 *   npm run issues -- list                  # #编号 + 标题 + 标签
 *   npm run issues -- list --json
 *   npm run issues -- show 10               # 正文
 *   npm run issues -- close 1 2 3 --comment "修复说明"
 *
 * 为什么要有 `list`：手工逐个 WebFetch issue 时我漏掉过一条（#10），
 * 因为任务清单是从记忆里列的，不是从 open 列表生成的。
 */
import { execFileSync } from 'node:child_process'

const REPO = process.env['GITHUB_REPO'] ?? 'limingzxc/BlockPilot'
const API = 'https://api.github.com'
const PROXY = process.env['BLOCKPILOT_PROXY'] ?? 'http://127.0.0.1:53179'

interface Issue {
  readonly number: number
  readonly title: string
  readonly body: string | null
  readonly labels: readonly { readonly name: string }[]
  readonly pull_request?: unknown
}

function token(): string | undefined {
  const env = process.env['GITHUB_TOKEN'] ?? process.env['BLOCKPILOT_GH_TOKEN']
  if (env !== undefined && env !== '') return env
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    return out
      .split('\n')
      .find((l) => l.startsWith('password='))
      ?.slice('password='.length)
  } catch {
    return undefined
  }
}

/** curl 一次。先直连，失败再走本地代理——两条路在不同网络下各有用。 */
function curl(url: string, init: { method?: string; body?: string; auth?: string }): string {
  const base = [
    '-sS',
    '-m',
    '40',
    '-X',
    init.method ?? 'GET',
    '-H',
    'User-Agent: blockpilot-dev',
    '-H',
    'Accept: application/vnd.github+json',
  ]
  if (init.auth !== undefined) base.push('-H', `Authorization: Bearer ${init.auth}`)
  if (init.body !== undefined) base.push('-H', 'Content-Type: application/json', '--data-binary', init.body)

  try {
    return execFileSync('curl', [...base, url], { encoding: 'utf8' })
  } catch {
    return execFileSync('curl', [...base, '-x', PROXY, url], { encoding: 'utf8' })
  }
}

function request(path: string, init: { method?: string; body?: string; auth?: string } = {}): unknown {
  const auth = init.auth ?? token()
  if (auth === undefined) {
    throw new Error('拿不到 GitHub token：设 GITHUB_TOKEN，或先让 git 记住凭据')
  }
  const text = curl(`${API}${path}`, { ...init, auth })
  if (text.trim() === '') return null
  return JSON.parse(text) as unknown
}

function openIssues(): Issue[] {
  const rows = request(`/repos/${REPO}/issues?state=open&per_page=100`) as Issue[]
  // issues 接口会把 PR 也列进来，过滤掉
  return rows.filter((i) => i.pull_request === undefined)
}

function argNumbers(argv: readonly string[]): number[] {
  return argv
    .filter((a) => /^\d+$/.test(a))
    .map((a) => Number(a))
}

function main(argv: readonly string[]): number {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'list') {
    const issues = openIssues()
    if (rest.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify(issues.map((i) => ({ number: i.number, title: i.title })), null, 2)}\n`,
      )
      return 0
    }
    for (const i of issues) {
      const labels = i.labels.map((l) => l.name).join(',')
      process.stdout.write(`#${i.number}  ${i.title}${labels === '' ? '' : `  [${labels}]`}\n`)
    }
    process.stdout.write(`\nopen: ${issues.length}\n`)
    return 0
  }

  if (cmd === 'show') {
    const n = argNumbers(rest)[0]
    if (n === undefined) {
      process.stderr.write('用法：issues show <编号>\n')
      return 1
    }
    const i = request(`/repos/${REPO}/issues/${n}`) as Issue
    process.stdout.write(`#${i.number} ${i.title}\n\n${i.body ?? ''}\n`)
    return 0
  }

  if (cmd === 'close') {
    const nums = argNumbers(rest)
    const at = rest.indexOf('--comment')
    const comment = at === -1 ? undefined : rest.slice(at + 1).join(' ')
    if (nums.length === 0) {
      process.stderr.write('用法：issues close <编号...> [--comment 说明]\n')
      return 1
    }
    for (const n of nums) {
      if (comment !== undefined) {
        request(`/repos/${REPO}/issues/${n}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: comment }),
        })
      }
      request(`/repos/${REPO}/issues/${n}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
      })
      process.stdout.write(`#${n} closed\n`)
    }
    return 0
  }

  process.stderr.write(`未知命令：${cmd}（可用：list / show / close）\n`)
  return 1
}

process.exit(main(process.argv.slice(2)))
