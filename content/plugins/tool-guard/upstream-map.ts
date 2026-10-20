import type { UpstreamRef } from '@harness-explorer/lesson-kit'

/** Excerpts of deepseek-harness at the commit pinned in upstream-lock.json. */
const refs: UpstreamRef[] = [
  { id: 'upstream:pre-execute-event', path: 'packages/core/tools/src/index.ts', symbol: "Events['tools/pre-execute']", startLine: 144, endLine: 154, contentHash: 'sha256:3540fa01d418f8b52a528777fccda15cb6a2b74304a671d3ab9bec4d5d897707' },
  { id: 'upstream:pre-execute-dispatch', path: 'packages/core/tools/src/index.ts', symbol: 'ToolRegistry.prepareExecution', startLine: 1511, endLine: 1515, contentHash: 'sha256:3d21066fdf87573d6fc39b670927beb8064dc212b39d1beaf9156102d5c16e7c' },
  { id: 'upstream:pre-tool-decision', path: 'packages/core/tools/src/index.ts', symbol: 'PreToolDecision', startLine: 608, endLine: 612, contentHash: 'sha256:2489ace25df8d258a107d3b8416570e319279c061db7b5bd906af09475b6b26d' },
  { id: 'upstream:post-execute-dispatch', path: 'packages/core/tools/src/index.ts', symbol: 'ToolRegistry.postExecute', startLine: 1790, endLine: 1793, contentHash: 'sha256:0ab9d478d0dd8e51fb63540709def3277293bbfcd6c701f4345e57046bed9d7d' },
  { id: 'upstream:cordis-waterfall', path: 'vendor/cordis/src/events.ts', symbol: 'EventsService.waterfall', startLine: 234, endLine: 243, contentHash: 'sha256:8ce6c2a92bab177c6cf853746d15a6bd4eacb3c4aab631d2626e0b21a792a42b' },
]

export default refs
