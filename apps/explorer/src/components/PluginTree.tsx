'use client'
/**
 * Plugin tree. Tree edges only mean composition; dependency and data edges are
 * separate layers with their own line style and text labels (docs/01 §3.1).
 * Node state comes from the replay projection, never from timers.
 */
import { useMemo } from 'react'
import { Background, Controls, Handle, Position, ReactFlow } from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Composition, PluginPhasePayload } from '@harness-explorer/contracts'
import type { ViewSnapshot } from '@harness-explorer/trace/browser'
import type { PublicStage } from '@/lib/api'
import type { Layer } from '@/lib/store'
import { phaseOf } from '@/lib/phase'

export { PHASE_LABEL, phaseOf } from '@/lib/phase'

type PluginNodeData = {
  instanceId: string
  stageId: string
  enabled: boolean
  plugin: PluginPhasePayload | undefined
  selected: boolean
}

function PluginNode({ data }: NodeProps<Node<PluginNodeData>>) {
  const phase = phaseOf(data.plugin, data.enabled)
  return (
    <div className={`plugin-node phase-${String(data.plugin?.phase ?? 'none')}${data.selected ? ' is-selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="plugin-node__title">{data.instanceId}</div>
      <div className="plugin-node__stage">{data.stageId}</div>
      <div className="plugin-node__phase"><span aria-hidden>{phase.mark}</span> {phase.text}</div>
      {data.plugin?.reason ? <div className="plugin-node__reason">{data.plugin.reason}</div> : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function ScopeNode({ data }: NodeProps<Node<{ label: string }>>) {
  return <div className="scope-node__label">作用域 {data.label}</div>
}

const nodeTypes = { plugin: PluginNode, scope: ScopeNode }

const COLUMNS = 4
const NODE_W = 200
const NODE_H = 110
const GAP = 24

interface Props {
  composition: Composition
  stages: readonly PublicStage[]
  snapshot: ViewSnapshot
  layer: Layer
  selectedInstanceId: string | null
  onSelect(id: string | null): void
}

export function PluginTree({ composition, stages, snapshot, layer, selectedInstanceId, onSelect }: Props) {
  const { nodes, edges } = useMemo(() => {
    const stageById = new Map(stages.map(stage => [stage.id, stage]))
    const nodes: Node[] = []
    let y = 0
    for (const scope of composition.scopes) {
      const members = composition.instances.filter(instance => instance.scopeId === scope.id)
      const rows = Math.max(1, Math.ceil(members.length / COLUMNS))
      const width = Math.min(Math.max(members.length, 1), COLUMNS) * (NODE_W + GAP) + GAP
      const height = rows * (NODE_H + GAP) + GAP + 24
      nodes.push({ id: `scope:${scope.id}`, type: 'scope', position: { x: 0, y }, data: { label: scope.id }, style: { width, height }, selectable: false, className: 'scope-node' })
      members.forEach((instance, index) => {
        nodes.push({
          id: instance.id,
          type: 'plugin',
          parentId: `scope:${scope.id}`,
          extent: 'parent',
          position: { x: GAP + (index % COLUMNS) * (NODE_W + GAP), y: 36 + Math.floor(index / COLUMNS) * (NODE_H + GAP) },
          data: {
            instanceId: instance.id,
            stageId: instance.stageId,
            enabled: instance.enabled,
            plugin: snapshot.plugins[instance.id],
            selected: instance.id === selectedInstanceId,
          } satisfies PluginNodeData,
        })
      })
      y += height + GAP * 2
    }

    const edges: Edge[] = []
    if (layer === 'composition') {
      for (const instance of composition.instances) {
        if (instance.parentId) {
          edges.push({ id: `tree:${instance.id}`, source: instance.parentId, target: instance.id, label: '子插件', className: 'edge-tree' })
        }
      }
    } else if (layer === 'dependency') {
      for (const consumer of composition.instances) {
        for (const service of stageById.get(consumer.stageId)?.requires ?? []) {
          const providers = composition.instances.filter(candidate => stageById.get(candidate.stageId)?.provides.includes(service))
          const resolved = snapshot.plugins[consumer.id]?.dependencyStatus === 'resolved' && snapshot.services[service]?.available
          for (const provider of providers) {
            edges.push({
              id: `dep:${consumer.id}:${service}:${provider.id}`,
              source: consumer.id,
              target: provider.id,
              label: `${resolved ? '已解析' : '声明'} ${service}`,
              className: resolved ? 'edge-dependency edge-resolved' : 'edge-dependency',
            })
          }
        }
      }
    } else {
      const providerOf = (service: string) => composition.instances.find(candidate => stageById.get(candidate.stageId)?.provides.includes(service))?.id
      for (const registration of Object.values(snapshot.registrations)) {
        const target = providerOf(registration.kind === 'tool' ? 'tools' : 'systemPrompt')
        if (!registration.instanceId || !target || registration.instanceId === target) continue
        edges.push({
          id: `data:${registration.registrationId}`,
          source: registration.instanceId,
          target,
          label: `已注册 ${registration.name}`,
          className: 'edge-data',
          animated: false,
        })
      }
    }
    return { nodes, edges }
  }, [composition, stages, snapshot, layer, selectedInstanceId])

  return (
    <div className="tree" aria-label="插件树">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_event, node) => onSelect(node.type === 'plugin' ? node.id : null)}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/** Text alternative of the tree for keyboard and screen-reader use. */
export function PluginList({ composition, snapshot, selectedInstanceId, onSelect }: Omit<Props, 'stages' | 'layer'>) {
  return (
    <ul className="plugin-list" aria-label="插件列表">
      {composition.scopes.map(scope => (
        <li key={scope.id}>
          <span className="plugin-list__scope">作用域 {scope.id}{scope.parentId ? `（父：${scope.parentId}）` : ''}</span>
          <ul>
            {composition.instances.filter(instance => instance.scopeId === scope.id).map((instance) => {
              const phase = phaseOf(snapshot.plugins[instance.id])
              return (
                <li key={instance.id}>
                  <button
                    type="button"
                    aria-pressed={instance.id === selectedInstanceId}
                    onClick={() => onSelect(instance.id)}
                  >
                    {instance.id} · {instance.stageId} · {phase.mark} {phase.text}
                  </button>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}
