/**
 * 生成一个 Prism 风格的实例目录，用来验证离线模式（读 jar 内元数据）。
 * 用法：node scripts/make-instance-fixture.mjs
 *
 * fixtures/instance-ok/    iris + sodium 都在 → 依赖满足
 * fixtures/instance-miss/  只有 iris        → 缺 sodium
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'

function modJar(meta) {
  return zipSync({
    'fabric.mod.json': strToU8(JSON.stringify(meta, null, 2)),
    'com/example/Dummy.class': strToU8('not a real class'),
  })
}

const irisMeta = {
  schemaVersion: 1,
  id: 'iris',
  version: '1.7.6',
  name: 'Iris',
  depends: {
    minecraft: '>=1.20.1',
    fabricloader: '>=0.14.21',
    sodium: '>=0.5.0',
  },
}

const sodiumMeta = {
  schemaVersion: 1,
  id: 'sodium',
  version: '0.5.13',
  name: 'Sodium',
  depends: { minecraft: '>=1.20.1', fabricloader: '>=0.14.21' },
}

const mmcPack = {
  formatVersion: 1,
  components: [
    { uid: 'net.minecraft', version: '1.20.1', important: true },
    { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' },
  ],
}

const layouts = [
  ['fixtures/instance-ok', { iris: true, sodium: true }],
  ['fixtures/instance-miss', { iris: true, sodium: false }],
]

for (const [dir, wants] of layouts) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(`${dir}/mods`, { recursive: true })
  mkdirSync(`${dir}/.minecraft`, { recursive: true })
  writeFileSync(`${dir}/mmc-pack.json`, JSON.stringify(mmcPack, null, 2))
  writeFileSync(`${dir}/instance.cfg`, 'name=Fixture\nInstanceType=OneSix\n')

  writeFileSync(`${dir}/mods/iris-1.7.6.jar`, modJar(irisMeta))
  if (wants.sodium) writeFileSync(`${dir}/mods/sodium-0.5.13.jar`, modJar(sodiumMeta))
  // 一个不是模组的 jar，用来验证 UNREADABLE_JAR
  writeFileSync(`${dir}/mods/not-a-mod.jar`, zipSync({ 'readme.txt': strToU8('hello') }))

  console.log('wrote', dir)
}
