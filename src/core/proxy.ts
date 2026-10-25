/**
 * 代理支持。
 *
 * 为什么需要代码而不是只设环境变量：Node 的 fetch 在启动时就固化了
 * dispatcher，`NODE_USE_ENV_PROXY` 必须在进程启动前设置——进程内改
 * `process.env.HTTPS_PROXY` 没有任何效果（实测验证过）。所以要靠
 * undici 的 ProxyAgent 在运行时替换全局 dispatcher。
 *
 * 只支持 http(s) 代理。undici 的 ProxyAgent 走 HTTP CONNECT，
 * 不支持 socks://——常见混合代理（如 1081 端口同时开 http 和 socks5）
 * 用 http:// 即可。
 *
 * 两个消费方：
 * - Node 的 fetch（元数据源、下载器）：setGlobalDispatcher
 * - Forge/NeoForge installer 是 **Java 程序**，有自己的下载栈，
 *   要靠 `-Dhttps.proxyHost` 这类 JVM 参数（见 setup/forge.ts）
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici'

let applied = false

/**
 * 环境变量的优先级：专用的 BLOCKPILOT_PROXY 最高，然后是通用约定。
 *
 * **空字符串视为未设置**。沙箱和 CI 常把 HTTPS_PROXY 设成空值来「关闭」代理，
 * `??` 不会跳过空串，不处理的话会走到「URL 无法解析」的报错里。
 */
export function proxyFromEnv(): string | undefined {
  const vars = [
    process.env.BLOCKPILOT_PROXY,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ]
  return vars.find((v) => v !== undefined && v !== '')
}

/**
 * 应用代理。返回实际生效的 URL；没有配置任何代理时返回 undefined（直连是合法状态）。
 *
 * 已应用过就跳过——dispatcher 是全局的，换两次没有意义。
 * URL 非法时抛错：用户显式给了代理却用不了，必须大声失败——
 * 静默直连的结果是「用户以为开了代理，实际还在裸连」。
 */
export function applyProxy(url?: string): string | undefined {
  const target = url ?? proxyFromEnv()
  if (target === undefined || target === '') return undefined

  let u: URL
  try {
    u = new URL(target)
  } catch {
    throw new Error(`代理 URL 无法解析：${target}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(
      `代理只支持 http(s)://，收到 ${u.protocol}//。` +
        `socks 代理请确认它同时开了 http 端口（常见混合代理是同一个端口）`,
    )
  }

  // userinfo 转成 Basic 认证。ProxyAgent 不认 URL 里的用户名密码
  const token =
    u.username === ''
      ? undefined
      : 'Basic ' +
        Buffer.from(
          `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
        ).toString('base64')

  setGlobalDispatcher(
    new ProxyAgent({
      uri: `${u.protocol}//${u.host}`,
      ...(token === undefined ? {} : { token }),
    }),
  )
  applied = true
  return `${u.protocol}//${u.host}`
}

/**
 * 给 Java 子进程用的代理参数。installer 是独立 JVM，不会继承 undici 的设置。
 *
 * Java 只认 `-Dhttps.proxyHost/-Dhttps.proxyPort` 这对属性，
 * 不认 URL 形式，所以要拆开。
 */
export function javaProxyArgs(proxyUrl: string | undefined): readonly string[] {
  if (proxyUrl === undefined || proxyUrl === '') return []
  const u = new URL(proxyUrl)
  const host = u.hostname
  const port = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port
  return [
    `-Dhttp.proxyHost=${host}`,
    `-Dhttp.proxyPort=${port}`,
    `-Dhttps.proxyHost=${host}`,
    `-Dhttps.proxyPort=${port}`,
  ]
}
