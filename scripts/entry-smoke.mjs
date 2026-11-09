/**
 * 包入口烟测：`package.json` 的 main/types/exports 指到 dist/index.js。
 *
 * CI 里 `npm run build` 只证明 tsc 能产出；这个脚本证明「按包名 import」也能拿到
 * 公共 API。`exports` 写错、`src/index.ts` 漏导出，只有这里会红。
 */
const REQUIRED = {
  createDeploy: 'function',
  createPreflight: 'function',
  createDiagnose: 'function',
  createVerify: 'function',
  checkUpdates: 'function',
  updateLoader: 'function',
  createQuiltSetup: 'function',
  createCredentialStore: 'function',
  resolveLayout: 'function',
  Op: 'object',
}

let mod
try {
  mod = await import('blockpilot')
} catch (err) {
  console.error('[entry] 无法 import 包入口；先 npm run build')
  console.error(err)
  process.exit(1)
}

const bad = []
for (const [name, type] of Object.entries(REQUIRED)) {
  if (typeof mod[name] !== type) bad.push(`${name}: 期望 ${type}，实际 ${typeof mod[name]}`)
}
if (typeof mod.Op?.log !== 'function') bad.push('Op.log: 不是函数')

if (bad.length > 0) {
  console.error(`[entry] 公共 API 不完整（${bad.length} 项）`)
  for (const line of bad) console.error(`  - ${line}`)
  process.exit(1)
}

console.log(`[entry] ${Object.keys(REQUIRED).length} 个公共导出可用`)
