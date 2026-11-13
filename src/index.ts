/**
 * 库入口。
 *
 * 这个文件存在的理由很具体：`package.json` 此前没有 `main` / `exports`，
 * 「core 可以被别的启动器 import」只停留在 ADR 里。现在至少有一个明确的
 * 公共面：Operation 构造器、事件类型、布局、错误与内容源契约。
 *
 * 不导出 `cli/` 与 `mcp/`：那两个是消费者入口，import 它们会执行顶层逻辑。
 */

export type { CredentialStore } from './core/auth/credentials.js'
export { createCredentialStore } from './core/auth/credentials.js'
export type { ContentSource, VersionInfo } from './core/content-source.js'
export type { CfFileInfo, CurseforgeLike } from './core/curseforge.js'
export type { DeployOptions, DeployResult } from './core/deploy/index.js'
export { createDeploy } from './core/deploy/index.js'
export type { DiagResult, DiagVerdict } from './core/diagnostics/index.js'
export { createDiagnose } from './core/diagnostics/index.js'
export { BlockPilotError, errMessage } from './core/errors.js'
export type {
  LogCode,
  LogEvent,
  LogPayloads,
  OpEvent,
  ResultEvent,
} from './core/events/index.js'
export { Op } from './core/events/index.js'
export { updateLoader } from './core/instance/loader-update.js'
export type { LockedFile, LockFile, VerifyResult } from './core/instance/lock.js'
export { createVerify, lockPath, readLock } from './core/instance/lock.js'
export type { UpdateCheckItem, UpdateCheckResult } from './core/instance/update.js'
export { checkUpdates } from './core/instance/update.js'
export type { LaunchPlan } from './core/launch/plan.js'
export { buildLaunchPlan } from './core/launch/plan.js'
export type { RunOptions, RunResult } from './core/launch/run.js'
export { createLauncher } from './core/launch/run.js'
export type { Layout } from './core/layout.js'
export { defaultRoot, LayoutError, resolveLayout } from './core/layout.js'
export type { PreflightOptions } from './core/preflight/index.js'
export { createPreflight } from './core/preflight/index.js'
export type { Finding, FindingCode, PreflightReport, Severity } from './core/preflight/types.js'
export type { Probe } from './core/probe.js'
export { createLoaderInstall, loaderNeedsJava, SUPPORTED_LOADERS } from './core/setup/loader.js'
export type { LoaderInstallOptions, LoaderInstallResult } from './core/setup/loader-types.js'
export {
  CurseforgeSource,
  MirrorCurseforgeSource,
  resolveCurseforge,
} from './sources/curseforge.js'
export { ModrinthSource } from './sources/modrinth.js'
