import type { Architecture } from '@harness-explorer/lesson-kit'

const architecture: Architecture = {
  nodes: [
    { id: 'guard', kind: 'entry', label: 'tool-guard', responsibility: '在工具执行前审计与拦截', sourceRefIds: ['tool-guard@02-deny#audit', 'tool-guard@02-deny#policy'], introducedAtStageId: '00-observe' },
    { id: 'pre-execute', kind: 'event', label: 'tools/pre-execute（waterfall）', responsibility: '工具体运行前的 around 决策链，默认决定是 allow', sourceRefIds: ['upstream:pre-execute-dispatch', 'upstream:pre-execute-event'], introducedAtStageId: '00-observe' },
    { id: 'tools-service', kind: 'class', label: 'Tools（tools 服务）', responsibility: '登记工具，按决定执行工具体并整理结果', sourceRefIds: ['upstream:pre-execute-dispatch'], introducedAtStageId: '00-observe' },
    { id: 'post-execute', kind: 'event', label: 'tools/post-execute（waterfall）', responsibility: '对执行或拒绝后的结果做接受、替换或拦截', sourceRefIds: ['upstream:post-execute-dispatch'], introducedAtStageId: '02-deny' },
  ],
  edges: [
    { id: 'guard-subscribes', from: 'guard', to: 'pre-execute', relation: 'subscribes', evidence: 'source', sourceRefIds: ['tool-guard@02-deny#audit'] },
    { id: 'tools-calls-pre', from: 'tools-service', to: 'pre-execute', relation: 'calls', evidence: 'source', sourceRefIds: ['upstream:pre-execute-dispatch'] },
    { id: 'tools-calls-post', from: 'tools-service', to: 'post-execute', relation: 'calls', evidence: 'source', sourceRefIds: ['upstream:post-execute-dispatch'] },
  ],
}

export default architecture
