import type { Architecture } from '@harness-explorer/lesson-kit'

const architecture: Architecture = {
  nodes: [
    {
      id: 'contributor',
      kind: 'entry',
      label: 'prompt-contributor',
      responsibility: '教学插件：声明依赖并贡献一段提示词',
      sourceRefIds: ['prompt-contributor@02-section#section'],
      introducedAtStageId: '00-entry',
    },
    {
      id: 'system-prompt-service',
      kind: 'class',
      label: 'SystemPrompt（systemPrompt 服务）',
      responsibility: '保存各作用域的提示词片段，并在每次请求前组装 system 文本',
      sourceRefIds: ['upstream:section'],
      introducedAtStageId: '01-dependency',
    },
    {
      id: 'section-registry',
      kind: 'registry',
      label: '片段注册表（按作用域分层）',
      responsibility: '同一层内名称唯一；内层同名片段覆盖外层',
      sourceRefIds: ['upstream:section', 'upstream:scoped-layers-effect'],
      introducedAtStageId: '02-section',
    },
    {
      id: 'cordis-effect',
      kind: 'resource',
      label: 'Cordis effect',
      responsibility: '把 disposer 绑定到调用方插件的生命周期，卸载时逆序执行',
      sourceRefIds: ['upstream:scoped-layers-effect'],
      introducedAtStageId: '03-disposal',
    },
    {
      id: 'change-event',
      kind: 'event',
      label: 'system-prompt/change',
      responsibility: '注册和释放片段时通知观察者',
      sourceRefIds: ['upstream:change-event', 'upstream:section'],
      introducedAtStageId: '02-section',
    },
  ],
  edges: [
    { id: 'contributor-requires-service', from: 'contributor', to: 'system-prompt-service', relation: 'requires', evidence: 'source', sourceRefIds: ['prompt-contributor@02-section#section'] },
    { id: 'contributor-registers-section', from: 'contributor', to: 'section-registry', relation: 'registers', evidence: 'source', sourceRefIds: ['prompt-contributor@02-section#section', 'upstream:section'] },
    { id: 'effect-disposes-section', from: 'cordis-effect', to: 'section-registry', relation: 'disposes', evidence: 'source', sourceRefIds: ['upstream:section', 'upstream:scoped-layers-effect'] },
    { id: 'service-reads-registry', from: 'system-prompt-service', to: 'section-registry', relation: 'reads', evidence: 'source', sourceRefIds: ['upstream:render-prompt'] },
    { id: 'registry-emits-change', from: 'section-registry', to: 'change-event', relation: 'calls', evidence: 'observed', sourceRefIds: ['upstream:change-event'] },
  ],
}

export default architecture
