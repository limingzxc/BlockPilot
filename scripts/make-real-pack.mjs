/**
 * 生成一个**可真装**的 mrpack：文件 URL 与 sha1 都是真实的，能通过哈希校验。
 *
 * 用自己的 demo 数据测不出问题——假哈希永远在校验那一关失败。
 * 用法：node scripts/make-real-pack.mjs
 */
import { writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

const index = {
  formatVersion: 1,
  game: '1.20.1',
  versionId: '1.0.0',
  name: 'BlockPilot Real Fixture',
  summary: '一个只有两个真实模组的最小整合包，用来验证 deploy 链路',
  files: [
    {
      path: 'mods/fabric-api-0.92.12+1.20.1.jar',
      hashes: { sha1: '3e9cdd3e2f827ca9a259df9eb8e31949437b6bd4', sha512: 'x' },
      env: { client: 'required', server: 'required' },
      downloads: [
        'https://cdn.modrinth.com/data/P7dR8mSH/versions/rvI2dfzR/fabric-api-0.92.12%2B1.20.1.jar',
      ],
      fileSize: 2137232,
    },
    {
      path: 'mods/sodium-fabric-0.5.13+mc1.20.1.jar',
      hashes: { sha1: 'bcdbf37d9494e405cba210d7a80ed58e756297b5', sha512: 'x' },
      env: { client: 'required', server: 'unsupported' },
      downloads: [
        'https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar',
      ],
      fileSize: 971552,
    },
    {
      // 服务端专用：deploy 应该跳过它
      path: 'mods/server-only-thing.jar',
      hashes: { sha1: '0000000000000000000000000000000000000000', sha512: 'x' },
      env: { client: 'unsupported', server: 'required' },
      downloads: ['https://example.invalid/never-downloaded.jar'],
      fileSize: 1,
    },
  ],
  dependencies: {
    minecraft: '1.20.1',
    // 必须 >= 0.16.10：fabric-api 0.92.12 的 fabric.mod.json 里写死了这个下限。
    // 用 0.15.11 会在启动时报 HARD_DEP（这是个真实的版本约束，不是我们造的）
    'fabric-loader': '0.16.14',
  },
}

const zip = zipSync({
  'modrinth.index.json': strToU8(JSON.stringify(index, null, 2)),
  'overrides/config/example.toml': strToU8('# 来自 overrides 的配置\nkey = "value"\n'),
  'client-overrides/options.txt': strToU8('renderDistance:8\n'),
})

writeFileSync('fixtures/real-pack.mrpack', zip)
console.log('wrote fixtures/real-pack.mrpack')
