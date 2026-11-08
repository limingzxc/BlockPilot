/**
 * 用户可见的「可照抄命令」。
 *
 * 这些字符串会被直接粘进终端。参数写错就是一次 404——`ASSETS_MISSING` 曾经
 * 提示 `blockpilot assets 5`（那是 asset index id，命令要的是 MC 版本），
 * 照敲会去取 `versions/5/5.json`。这类错误没有类型能挡，只能靠
 * `src/cli/hints.test.ts` 把渲染结果解析回 argv 再校验一遍。
 */

/** 含空格或引号时加双引号，否则原样返回。路径里有空格时不能裸拼。 */
export function quoteArg(value: string): string {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

export function javaInstallHint(major: number | string): string {
  return `blockpilot java install ${major}`
}

/** `version` 必须是 MC 版本号或加载器版本 id，不能是 asset index id。 */
export function assetsHint(version: string): string {
  return `blockpilot assets ${version} --root <root>`
}

export function setupHint(version: string, root = '<root>'): string {
  return `blockpilot setup ${version} --root ${quoteArg(root)}`
}

export function runHint(versionId: string, root = '<root>', instance?: string): string {
  const base = `blockpilot run ${versionId} --root ${quoteArg(root)}`
  return instance === undefined ? base : `${base} --instance ${instance}`
}

export function diagHint(root = '<root>', instance = 'default'): string {
  return `blockpilot diag --root ${quoteArg(root)} --instance ${instance}`
}

export function preflightHint(dir: string): string {
  return `blockpilot preflight ${quoteArg(dir)}`
}
