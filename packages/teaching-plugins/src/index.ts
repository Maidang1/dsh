/**
 * Type surface of the teaching plugins. Importing this module also loads their
 * Cordis Context and Events augmentations.
 */
export type { PromptSection, PromptAssembly, SectionEntry, ToolSchema } from '../system-prompt/stages/main/index.ts'
export type { DurableEventType, HistoryMessage, SessionEvent, ToolCall } from '../session/stages/main/index.ts'
export type { ModelAdapter, ModelChunk, ModelRequest, ModelResponse } from '../llm/stages/main/index.ts'
export type { PostToolDecision, PreToolDecision, ToolDefinition, ToolEntry, ToolExecution, ToolResult } from '../tools/stages/main/index.ts'
export type { PreStep, PreStepDecision, TurnEndReason } from '../agent-loop/stages/main/index.ts'
export { ROOT_SCOPE, SCOPE_CHAIN, scopeChainOf, withScopeChain } from '../shared/scope.ts'
export { checkpoint } from '../shared/checkpoint.ts'
export { devStages, responsibilities } from './catalog.ts'
