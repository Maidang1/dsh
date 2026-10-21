/**
 * Development catalog of executable stages, loaded straight from source.
 * lesson-kit replaces `module` and `sourceHash` with built artifacts.
 */
import type { ExecutableStageDefinition, PluginLayer, PluginResponsibility } from '@harness-explorer/contracts'
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
  stage('llm-deepseek', 'main', ['llm'], []),
  stage('agent-loop', 'main', ['sessions', 'llm', 'tools', 'systemPrompt'], ['agentLoop']),
  stage('prompt-contributor', '00-entry', [], []),
  stage('prompt-contributor', '01-dependency', ['systemPrompt'], []),
  stage('prompt-contributor', '02-section', ['systemPrompt'], []),
  stage('calculator', 'main', ['tools'], []),
  stage('tool-guard', '00-observe', ['tools'], []),
  stage('tool-guard', '01-two-layers', ['tools'], []),
  stage('tool-guard', '02-deny', ['tools'], []),
]

/** Responsibility of each plugin definition in devStages. */
export const responsibilities: Readonly<Record<string, PluginResponsibility>> = {
  'session': 'session',
  'system-prompt': 'prompt',
  'tools': 'tool',
  'llm': 'model',
  'llm-scripted': 'model',
  'llm-deepseek': 'model',
  'agent-loop': 'agent-loop',
  'prompt-contributor': 'prompt',
  'calculator': 'tool',
  'tool-guard': 'event-policy',
}

/**
 * Layer of each plugin definition in the layered plugin tree
 * (docs/design/explorer-redesign.md §5.2): 1 基础服务、2 能力、3 扩展、4 编排.
 */
export const layers: Readonly<Record<string, PluginLayer>> = {
  'session': 1,
  'system-prompt': 1,
  'llm': 1,
  'tools': 2,
  'llm-scripted': 2,
  'llm-deepseek': 2,
  'prompt-contributor': 3,
  'calculator': 3,
  'tool-guard': 3,
  'agent-loop': 4,
}
