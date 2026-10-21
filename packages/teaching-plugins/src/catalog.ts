/**
 * Development catalog of executable stages. Teaching stages load straight from
 * source (lesson-kit replaces `module` and `sourceHash` with built artifacts);
 * upstream stages are the installed npm packages themselves.
 */
import type { ExecutableStageDefinition, PluginResponsibility } from '@harness-explorer/contracts'
import { fileURLToPath } from 'node:url'
import { kernelPlugins, kernelStages } from './upstream.ts'

const source = (path: string) => fileURLToPath(new URL(`../${path}/index.ts`, import.meta.url))

function stage(pluginDefinitionId: string, stageName: string, requires: string[], provides: string[]): ExecutableStageDefinition {
  return {
    id: `${pluginDefinitionId}@${stageName}`,
    pluginDefinitionId,
    origin: 'teaching',
    module: source(`${pluginDefinitionId}/stages/${stageName}`),
    sourceHash: 'dev',
    requires,
    provides,
    upstreamCommit: null,
  }
}

/** Project-written plugins: the lessons' subjects and the deterministic model adapter. */
export const teachingStages: readonly ExecutableStageDefinition[] = [
  stage('llm-scripted', 'main', ['llm'], []),
  stage('prompt-contributor', '00-entry', [], []),
  stage('prompt-contributor', '01-dependency', ['systemPrompt'], []),
  stage('prompt-contributor', '02-section', ['systemPrompt'], []),
  stage('calculator', 'main', ['tools'], []),
  stage('tool-guard', '00-observe', ['tools'], []),
  stage('tool-guard', '01-two-layers', ['tools'], []),
  stage('tool-guard', '02-deny', ['tools'], []),
]

export const devStages: readonly ExecutableStageDefinition[] = [...kernelStages(), ...teachingStages]

/** Responsibility of each plugin definition in devStages. */
export const responsibilities: Readonly<Record<string, PluginResponsibility>> = {
  ...Object.fromEntries(kernelPlugins.map(plugin => [plugin.definitionId, plugin.responsibility])),
  'llm-scripted': 'model',
  'prompt-contributor': 'prompt',
  'calculator': 'tool',
  'tool-guard': 'event-policy',
}
