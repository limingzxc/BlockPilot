/** 依赖声明的归一化构造。 */

import type { ModDependency } from './types.js'

export function normDep(
  modId: string,
  mandatory: boolean,
  range?: string,
  kind?: 'breaks',
): ModDependency {
  return {
    modId,
    mandatory,
    ...(range === undefined || range === '' ? {} : { versionRange: range }),
    ...(kind === undefined ? {} : { kind }),
  }
}
