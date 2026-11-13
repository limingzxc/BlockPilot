/** Forge / NeoForge 安装器域事件载荷。 */
export interface ForgePayloads {
  'forge.already_installed': { readonly versionId: string }
  'forge.installer_url': { readonly url: string }
  'forge.installer_downloaded': { readonly bytes: number }
  'forge.installer_mirrored': { readonly from: string; readonly to: string }
  'forge.installer_mirror_failed': { readonly error: string }
  'forge.installer_run': { readonly note: string }
  'forge.installer_retry': { readonly code: number | null; readonly tail: readonly string[] }
  'forge.installer_failed': { readonly code: number | null; readonly tail: readonly string[] }
  'forge.installed': { readonly versionId: string }
}
