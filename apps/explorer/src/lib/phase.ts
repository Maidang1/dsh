/** Text for an instance's lifecycle state in the tree, inspector and lessons. */
import type { PluginPhasePayload } from '@harness-explorer/contracts'

export const PHASE_LABEL: Record<string, { mark: string; text: string }> = {
  active: { mark: '●', text: '已激活' },
  pending: { mark: '◐', text: '等待中' },
  loading: { mark: '↻', text: '加载中' },
  failed: { mark: '✕', text: '加载失败' },
  unloading: { mark: '⇣', text: '卸载中' },
  null: { mark: '○', text: '无活动 Fiber' },
  none: { mark: '·', text: '本次运行未加载' },
}

/**
 * State shown for an instance (docs/01 §5.3): not enabled, waiting for a
 * service, failed and no active fiber stay distinct, and a pending instance
 * is only called waiting for a service when the runner reported one missing.
 */
export function phaseOf(plugin: PluginPhasePayload | undefined, enabled = true) {
  if (!plugin) return enabled ? PHASE_LABEL.none! : { mark: '·', text: '未启用（由场景挂载）' }
  if (plugin.phase === 'pending') {
    if (plugin.dependencyStatus === 'missing') return { mark: '◐', text: '等待服务' }
    if (plugin.dependencyStatus === 'unknown') return { mark: '◐', text: '等待中（原因未知）' }
  }
  return PHASE_LABEL[String(plugin.phase)]!
}
