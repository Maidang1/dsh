import type { Architecture } from '@harness-explorer/lesson-kit'

const architecture: Architecture = {
  nodes: [
    {
      id: 'service',
      kind: 'class',
      label: '系统提示词管理程序（SystemPrompt）',
      responsibility: '收好各段说明，最后整理成模型要读的文本',
      sourceRefIds: ['system-prompt@0.2.1-rc.2#system-prompt-config', 'system-prompt@0.2.1-rc.2#system-prompt-sections'],
      introducedAtStageId: '00-service-config',
    },
    {
      id: 'configuration',
      kind: 'type',
      label: '启动设置（Config）',
      responsibility: '决定是否加入身份说明，以及部署者提供的角色说明',
      sourceRefIds: ['system-prompt@0.2.1-rc.2#system-prompt-config'],
      introducedAtStageId: '00-service-config',
    },
    {
      id: 'section-registry',
      kind: 'registry',
      label: '说明清单',
      responsibility: '按适用范围保存每段说明，并按数字顺序排列',
      sourceRefIds: [
        'system-prompt@0.2.1-rc.2#system-prompt-sections',
        'system-prompt@0.2.1-rc.2#prompt-layer',
        'system-prompt@0.2.1-rc.2#section-orders',
        'system-prompt@0.2.1-rc.2#compare-sections',
      ],
      introducedAtStageId: '01-section-registration',
    },
    {
      id: 'dynamic-inputs',
      kind: 'resource',
      label: '额外信息',
      responsibility: '提供请求时才确定的背景、填空值和工具说明',
      sourceRefIds: [
        'system-prompt@0.2.1-rc.2#context-provider',
        'system-prompt@0.2.1-rc.2#tools-provider',
        'system-prompt@0.2.1-rc.2#variable-provider',
      ],
      introducedAtStageId: '03-context-variables-tools',
    },
    {
      id: 'prompt-renderer',
      kind: 'function',
      label: '整理文本（renderPrompt）',
      responsibility: '填好空位、删掉空段，再把剩余说明连接起来',
      sourceRefIds: ['system-prompt@0.2.1-rc.2#interpolate', 'system-prompt@0.2.1-rc.2#render-prompt'],
      introducedAtStageId: '04-assembly-rendering',
    },
  ],
  edges: [
    { id: 'configuration-constructs-service', from: 'configuration', to: 'service', relation: 'requires', evidence: 'source', sourceRefIds: ['system-prompt@0.2.1-rc.2#system-prompt-config'] },
    { id: 'service-registers-sections', from: 'service', to: 'section-registry', relation: 'registers', evidence: 'source', sourceRefIds: ['system-prompt@0.2.1-rc.2#system-prompt-sections'] },
    { id: 'service-assembles-inputs', from: 'service', to: 'dynamic-inputs', relation: 'reads', evidence: 'source', sourceRefIds: ['system-prompt@0.2.1-rc.2#assemble'] },
    { id: 'service-renders-prompt', from: 'service', to: 'prompt-renderer', relation: 'calls', evidence: 'source', sourceRefIds: ['system-prompt@0.2.1-rc.2#render-prompt', 'system-prompt@0.2.1-rc.2#interpolate'] },
  ],
}

export default architecture
