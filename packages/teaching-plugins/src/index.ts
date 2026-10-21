/**
 * Teaching plugins and the catalog of every executable stage. The plugin
 * services themselves come from the upstream packages; importing their types
 * loads their Cordis Context and Events augmentations.
 */
export { checkpoint } from '../shared/checkpoint.ts'
export { SCRIPTED_PROVIDER, ScriptMismatchError } from '../llm-scripted/stages/main/index.ts'
export { devStages, responsibilities, teachingStages } from './catalog.ts'
export {
  UPSTREAM_COMMIT,
  UPSTREAM_SCOPE,
  UPSTREAM_VERSION,
  UpstreamPackageError,
  kernelPlugins,
  kernelStages,
  resolvePackage,
  sha256,
  upstreamStage,
} from './upstream.ts'
export type { UpstreamPlugin } from './upstream.ts'
