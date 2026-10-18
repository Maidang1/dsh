/**
 * Development catalog of executable stages, loaded straight from source.
 * lesson-kit replaces `module` and `sourceHash` with built artifacts.
 */
import type { ExecutableStageDefinition } from '@harness-explorer/contracts'
import { fileURLToPath } from 'node:url'

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

export const devStages: readonly ExecutableStageDefinition[] = [
  stage('session', 'main', [], ['sessions']),
  stage('system-prompt', 'main', [], ['systemPrompt']),
  stage('tools', 'main', ['systemPrompt'], ['tools']),
  stage('llm', 'main', [], ['llm']),
  stage('llm-scripted', 'main', ['llm'], []),
  stage('agent-loop', 'main', ['sessions', 'llm', 'tools', 'systemPrompt'], ['agentLoop']),
  stage('prompt-contributor', '00-entry', [], []),
  stage('prompt-contributor', '01-dependency', ['systemPrompt'], []),
  stage('prompt-contributor', '02-section', ['systemPrompt'], []),
  stage('calculator', 'main', ['tools'], []),
  stage('tool-guard', '00-observe', ['tools'], []),
  stage('tool-guard', '01-two-layers', ['tools'], []),
  stage('tool-guard', '02-deny', ['tools'], []),
]
