/** docs/01 §5.3: not enabled, waiting for a service, failed and no active fiber stay distinct. */
import type { PluginPhasePayload } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { phaseOf } from '../src/lib/phase'

const at = (phase: PluginPhasePayload['phase'], dependencyStatus: PluginPhasePayload['dependencyStatus'] = 'resolved'): PluginPhasePayload =>
  ({ phase, dependencyStatus, reason: null, error: null })

describe('instance state text', () => {
  it.each([
    ['never loaded', undefined, true, '本次运行未加载'],
    ['not enabled, waiting for its mount step', undefined, false, '未启用（由场景挂载）'],
    ['pending with a missing service', at('pending', 'missing'), true, '等待服务'],
    ['pending without evidence', at('pending', 'unknown'), true, '等待中（原因未知）'],
    ['pending with dependencies resolved', at('pending'), true, '等待中'],
    ['failed', at('failed'), true, '加载失败'],
    ['disposed', at(null), true, '无活动 Fiber'],
  ])('%s', (_name, plugin, enabled, text) => {
    expect(phaseOf(plugin, enabled).text).toBe(text)
  })
})
