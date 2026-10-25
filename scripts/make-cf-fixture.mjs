/**
 * 造一个 CurseForge 格式的整合包 fixture。
 *
 * manifest 的字段抄自 GDLauncher 文档确认过的真实格式；
 * projectID/fileID 用的是真实存在的模组（JEI 238222、AppleSkin 248787），
 * 但只有 CF 的 API 能把它们解析成下载地址——这正是本 fixture 要演示的边界。
 *
 * 用法：node scripts/make-cf-fixture.mjs
 */
import { strToU8, zipSync } from 'fflate'
import { writeFileSync } from 'node:fs'

const manifest = {
  manifestType: 'minecraftModpack',
  manifestVersion: 1,
  name: 'CF Fixture',
  version: '1.0.0',
  author: 'BlockPilot',
  minecraft: {
    version: '1.20.1',
    modLoaders: [{ id: 'forge-47.3.0', primary: true }],
  },
  files: [
    { projectID: 238222, fileID: 4609596, required: true },
    { projectID: 248787, fileID: 4747899, required: true },
  ],
  overrides: 'overrides',
}

writeFileSync(
  'fixtures/cf-pack.zip',
  zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'overrides/config/cf-fixture.toml': strToU8('# from overrides\nenabled = true\n'),
    'modlist.html': strToU8('<ul><li>JEI</li><li>AppleSkin</li></ul>'),
  }),
)
console.log('wrote fixtures/cf-pack.zip (manifest: 1.20.1 + forge-47.3.0, 2 个必需文件)')
