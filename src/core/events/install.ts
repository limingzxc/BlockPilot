/** install 命令域事件载荷。 */
export interface InstallPayloads {
  'install.nothing_to_do': undefined
  'install.partial': { readonly ok: number; readonly failed: number }
}
