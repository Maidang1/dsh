import type { UpstreamRef } from '@harness-explorer/lesson-kit'

/** Excerpts of deepseek-harness at the commit pinned in upstream-lock.json. */
const refs: UpstreamRef[] = [
  {
    id: 'upstream:section',
    path: 'packages/core/system-prompt/src/index.ts',
    symbol: 'SystemPrompt.section',
    startLine: 478,
    endLine: 487,
    contentHash: 'sha256:7132d3a8f5f4a420fee061b509f4ec29c7e85d77ad072c1a44e30a6045a3019a',
  },
  {
    id: 'upstream:render-prompt',
    path: 'packages/core/system-prompt/src/index.ts',
    symbol: 'renderPrompt',
    startLine: 290,
    endLine: 295,
    contentHash: 'sha256:63fc8ff40433a20116c06c122c5f84adc67e1739a4496439158f47d676d6f3df',
  },
  {
    id: 'upstream:scoped-layers-effect',
    path: 'packages/core/scope/src/store.ts',
    symbol: 'ScopedLayers.effect',
    startLine: 226,
    endLine: 266,
    contentHash: 'sha256:1f58c10f11167a799efe71b7bd94508f0afdf69aa8649b6a7ab41437939a48ce',
  },
  {
    id: 'upstream:change-event',
    path: 'packages/core/system-prompt/src/index.ts',
    symbol: "Events['system-prompt/change']",
    startLine: 37,
    endLine: 37,
    contentHash: 'sha256:00c0b9d3d9efc311b5b669a72ec7c168a1b562b1e4f9fb1fe97fbb9535de4def',
  },
]

export default refs
