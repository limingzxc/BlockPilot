/**
 * maven 坐标 → 仓库内路径。
 *
 * `group:artifact:version[:classifier]` → `group/path/artifact/version/artifact-version[-classifier].jar`
 *
 * 为什么需要它：Mojang 的库带 `downloads.artifact.path`，路径是现成的；
 * 而 Fabric 等加载器只给 `name` + `url`，路径得自己算。
 */
export function mavenCoordToPath(name: string): string | null {
  const parts = name.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version, classifier] = parts
  if (group === undefined || artifact === undefined || version === undefined) return null
  if (group === '' || artifact === '' || version === '') return null
  const groupPath = group.replace(/\./g, '/')
  const suffix = classifier === undefined || classifier === '' ? '' : `-${classifier}`
  const file = `${artifact}-${version}${suffix}.jar`
  return `${groupPath}/${artifact}/${version}/${file}`
}
