'use client'
/**
 * Layered plugin tree (docs/design/explorer-redesign.md §2.3–2.4): horizontal
 * bands L0–L4 with names and captions, node cards with a status dot and a
 * provides/requires subtitle, scope containers as dashed boxes, and per-layer
 * edges — composition, dependency, or the request data flow at the cursor.
 * Node state comes from the replay projection, never from timers.
 */
import { useEffect, useMemo, useState } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, useReactFlow } from '@xyflow/react'
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Composition, PluginInstance, PluginLayer, PluginPhasePayload } from '@harness-explorer/contracts'
import type { ViewSnapshot } from '@harness-explorer/trace/browser'
import type { LessonsResponse, PublicStage } from '@/lib/api'
import type { Layer } from '@/lib/store'
import { phaseOf } from '@/lib/phase'
import { LAYER_META, assignLayers, flowStepsByInstance } from '@/lib/dataflow'
import type { RequestFlow } from '@/lib/dataflow'
import { scopeBoxes } from '@/lib/scope-boxes'

export { PHASE_LABEL, phaseOf } from '@/lib/phase'

type PluginNodeData = {
  instanceId: string
  subtitle: string
  enabled: boolean
  plugin: PluginPhasePayload | undefined
  selected: boolean
  isNew: boolean
  flowCurrent: boolean
  lessonStages: number | null
  openLesson: (() => void) | null
  select: () => void
  [key: string]: unknown
}

function PluginNode({ data }: NodeProps<Node<PluginNodeData>>) {
  const phase = phaseOf(data.plugin, data.enabled)
  return (
    <div
      className={`plugin-node phase-${String(data.plugin?.phase ?? 'none')}${data.selected ? ' is-selected' : ''}${data.flowCurrent ? ' is-flow-current' : ''}`}
      // Enter/Space select like a click; Enter on the selected node opens its
      // lesson (the hint's ↵). No aria-label: the accessible name comes from
      // the card's visible text.
      tabIndex={0}
      role="button"
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Enter' && data.selected && data.openLesson) data.openLesson()
        else data.select()
      }}
    >
      {data.isNew ? <span className="plugin-node__new">+ 新增</span> : null}
      <Handle type="target" position={Position.Top} />
      {/* Upward data-flow edges leave from the top so they never cross badges below the node. */}
      <Handle type="source" position={Position.Top} id="ts" />
      <div className="plugin-node__head">
        <span className="plugin-node__icon" aria-hidden>◇</span>
        <span className="plugin-node__title">{data.instanceId}</span>
        <span className="plugin-node__dot" aria-hidden />
      </div>
      <div className="plugin-node__sub">{data.subtitle}</div>
      <div className="plugin-node__phase"><span aria-hidden>{phase.mark}</span> {phase.text}</div>
      {data.plugin?.reason ? <div className="plugin-node__reason">{data.plugin.reason}</div> : null}
      {data.selected && data.lessonStages !== null ? (
        <span className="plugin-node__lesson-hint">双击进入源码 · {data.lessonStages} 个阶段 ↵</span>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function BandNode({ data }: NodeProps<Node<{ name: string; caption: string; alt: boolean }>>) {
  return (
    <div className={`layer-band${data.alt ? ' layer-band--alt' : ''}`} style={{ width: '100%', height: '100%' }}>
      <div className="layer-band__label">
        <span className="layer-band__name">{data.name}</span>
        <span className="layer-band__caption">{data.caption}</span>
      </div>
    </div>
  )
}

function RootNode() {
  return (
    <div className="root-node">
      <Handle type="source" position={Position.Bottom} />
      ◈ root
    </div>
  )
}

function ScopeNode({ data }: NodeProps<Node<{ label: string; parent: string | null }>>) {
  return <div className="scope-node__label">作用域 {data.label} ⊂ {data.parent ?? 'root'}</div>
}

function FlowLabelNode({ data }: NodeProps<Node<{ label: string; step: number | null; count: number; state: string }>>) {
  return (
    <span className={`flow-label flow-label--${data.state}`} title={data.count > 1 ? `${data.count} 条窗口内记录，显示最新一条` : undefined}>
      {data.step !== null ? <span className="flow-label__num">{data.step}</span> : null}
      {data.label}
      {data.count > 1 ? <span className="flow-label__count">+{data.count - 1}</span> : null}
    </span>
  )
}

/** Rounded polyline through the given points (right-angle routing with soft corners). */
export function cornerPath(rawPoints: ReadonlyArray<readonly [number, number]>, radius: number): string {
  // Drop zero-length segments (a channel aligned with the source/target centre
  // collapses a leg); they would divide by zero in the corner math.
  const points = rawPoints.filter((point, index) => index === 0 || point[0] !== rawPoints[index - 1]![0] || point[1] !== rawPoints[index - 1]![1])
  if (points.length < 2) return ''
  let path = `M ${points[0]![0]} ${points[0]![1]}`
  for (let index = 1; index < points.length - 1; index++) {
    const [px, py] = points[index - 1]!
    const [cx, cy] = points[index]!
    const [nx, ny] = points[index + 1]!
    const inLength = Math.hypot(cx - px, cy - py)
    const outLength = Math.hypot(nx - cx, ny - cy)
    if (inLength === 0 || outLength === 0) continue
    const r = Math.min(radius, inLength / 2, outLength / 2)
    const ix = cx - ((cx - px) / inLength) * r
    const iy = cy - ((cy - py) / inLength) * r
    const ox = cx + ((nx - cx) / outLength) * r
    const oy = cy + ((ny - cy) / outLength) * r
    path += ` L ${ix} ${iy} Q ${cx} ${cy} ${ox} ${oy}`
  }
  const last = points.at(-1)!
  path += ` L ${last[0]} ${last[1]}`
  return path
}

/**
 * Data-flow edge with a layer-aware right-angle route (§2.4): out of the
 * source, onto a vertical channel at `data.channel` that is guaranteed to
 * cross no node in the layers between, then into the target. The label sits
 * on that channel's midpoint, so it never overlaps a node card.
 */
function ChannelEdge(props: EdgeProps) {
  const data = props.data as { packet?: boolean; step?: number | null; channel?: number; label?: string } | undefined
  const channel = data?.channel
  const up = props.sourceY > props.targetY
  if (channel === undefined) {
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY,
      sourcePosition: props.sourcePosition, targetPosition: props.targetPosition, borderRadius: 12,
    })
    return (
      <>
        <BaseEdge id={props.id} path={path} />
        {props.label ? (
          <EdgeLabelRenderer>
            <span className={`flow-label edge-label${data?.packet ? ' flow-label--current' : ''}`} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'none' }}>
              {data?.step ? <span className="flow-label__num">{data.step}</span> : null}
              {props.label as string}
            </span>
          </EdgeLabelRenderer>
        ) : null}
      </>
    )
  }
  const exit = up ? props.sourceY - 14 : props.sourceY + 14
  const enter = props.targetY - 14
  const points: Array<readonly [number, number]> = [
    [props.sourceX, props.sourceY],
    [props.sourceX, exit],
    [channel, exit],
    [channel, enter],
    [props.targetX, enter],
    [props.targetX, props.targetY],
  ]
  const path = cornerPath(points, 8)
  const labelX = channel
  const labelY = (exit + enter) / 2
  return (
    <>
      <BaseEdge id={props.id} path={path} />
      {props.label ? (
        <EdgeLabelRenderer>
          <span className={`flow-label edge-label${data?.packet ? ' flow-label--current' : ''}`} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'none' }}>
            {data?.step ? <span className="flow-label__num">{data.step}</span> : null}
            {props.label as string}
          </span>
          {data?.packet ? <span className="edge-packet-dot" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 18}px)`, pointerEvents: 'none' }} /> : null}
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

/** All edges are smoothstep with a text label; the current data edge carries a packet dot. */
function LabeledEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
    borderRadius: 12,
  })
  const packet = (props.data as { packet?: boolean } | undefined)?.packet
  const step = (props.data as { step?: number | null } | undefined)?.step
  return (
    <>
      <BaseEdge id={props.id} path={path} />
      <EdgeLabelRenderer>
        <span className={`flow-label edge-label${packet ? ' flow-label--current' : ''}`} style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'none' }}>
          {step ? <span className="flow-label__num">{step}</span> : null}
          {props.label as string}
        </span>
        {packet ? <span className="edge-packet-dot" style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 16}px)`, pointerEvents: 'none' }} /> : null}
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { plugin: PluginNode, band: BandNode, root: RootNode, scope: ScopeNode, flowLabel: FlowLabelNode }
const edgeTypes = { labeled: LabeledEdge, channel: ChannelEdge }

const LABEL_W = 156
const NODE_W = 200
const NODE_H = 84
const ROW_H = 104
const GAP_X = 64
const BAND_PAD_TOP = 44
const BAND_PAD_BOTTOM = 24
/** Extra band height in the data-flow layer so badges below nodes stay inside their band. */
const BADGE_ROOM = 56
/** Estimated width of a flow badge, for keeping vertical edge channels clear of them. */
const BADGE_W = 170
/** Half the width of an edge label pill (plus margin): labelled edges need channels this far from nodes, not just line-clearance. */
const LABEL_CLEARANCE = 68
const MIN_CANVAS_W = 1240

/** Keep the graph clear of the floating canvas tools (top) and replay bar (bottom). */
const FIT_PADDING = { top: '56px', bottom: '100px', left: '12px', right: '12px' } as const

/** Bottom clearance under the floating replay bar, measured so wrapped/tall bars never cover the graph. */
function useReplayBarClearance(bar: HTMLDivElement | null) {
  const [clearance, setClearance] = useState(100)
  useEffect(() => {
    if (!bar) return
    const update = () => setClearance(Math.max(100, Math.round(bar.getBoundingClientRect().height) + 20))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [bar])
  return clearance
}

/** Refit the canvas when its container resizes (panel open/close, window changes). */
function FitOnResize({ bottom, tree }: { bottom: number; tree: HTMLDivElement | null }) {
  const flow = useReactFlow()
  useEffect(() => {
    if (!tree) return
    const refit = () => void flow.fitView({ padding: { ...FIT_PADDING, bottom: `${bottom}px` }, maxZoom: 1 })
    const observer = new ResizeObserver(refit)
    observer.observe(tree)
    refit()
    return () => observer.disconnect()
  }, [flow, bottom, tree])
  return null
}

/** The trace drawer covers the canvas bottom; refit so the graph stays fully visible. */
function FitForDrawer({ open, bottom, tree }: { open: boolean; bottom: number; tree: HTMLDivElement | null }) {
  const flow = useReactFlow()
  useEffect(() => {
    const clearance = open && tree ? Math.max(bottom, Math.min(346, tree.clientHeight * 0.45) + 116) : bottom
    void flow.fitView({ padding: { ...FIT_PADDING, bottom: `${Math.round(clearance)}px` }, maxZoom: 1, duration: 200 })
  }, [flow, open, bottom, tree])
  return null
}

/** Provides/requires one-liner shared by the canvas nodes and the list rows. */
function subtitleOf(instance: PluginInstance, stageById: ReadonlyMap<string, PublicStage>) {
  const stage = stageById.get(instance.stageId)
  if (!stage) return ''
  if (stage.provides.length) return `→ ${stage.provides.join(' · ')}`
  if (stage.requires.length > 2) return `← ${stage.requires.length} 个服务`
  if (stage.requires.length) return `← ${stage.requires.join(' · ')}`
  return ''
}

interface Props {
  composition: Composition
  stages: readonly PublicStage[]
  catalogLayers: Readonly<Record<string, PluginLayer>>
  snapshot: ViewSnapshot
  layer: Layer
  flow: RequestFlow | null
  /** Instances added in the draft relative to the selected run's revision. */
  addedIds: ReadonlySet<string>
  lessons: LessonsResponse | null
  selectedInstanceId: string | null
  /** The trace drawer floats over the canvas bottom; the graph refits around it. */
  drawerOpen?: boolean
  /** Elements owned by the Workbench: the canvas container and the replay bar
      floating over it (no document.querySelector). */
  treeElement: HTMLDivElement | null
  replayBarElement: HTMLDivElement | null
  onTreeElement(element: HTMLDivElement | null): void
  onSelect(id: string | null): void
  onOpenLesson(instance: PluginInstance): void
}

export function PluginTree({ composition, stages, catalogLayers, snapshot, layer, flow, addedIds, lessons, selectedInstanceId, drawerOpen = false, treeElement, replayBarElement, onTreeElement, onSelect, onOpenLesson }: Props) {
  const barClearance = useReplayBarClearance(replayBarElement)
  const { nodes, edges } = useMemo(() => {
    const stageById = new Map(stages.map(stage => [stage.id, stage]))
    const layers = assignLayers(composition.instances, stages, catalogLayers)
    const lessonStagesOf = (instance: PluginInstance) => {
      const lesson = lessons?.lessons.find(item => item.pluginDefinitionId === instance.definitionId)
      return lesson ? lesson.stages.length : null
    }

    // Lay nodes out by layer band, wrapping columns inside the band.
    const byLayer = new Map<number, PluginInstance[]>()
    for (const instance of composition.instances) {
      const key = layers.get(instance.id) ?? 1
      byLayer.set(key, [...byLayer.get(key) ?? [], instance])
    }
    let maxCols = 1
    for (const members of byLayer.values()) maxCols = Math.max(maxCols, members.length)
    const canvasW = Math.max(MIN_CANVAS_W, LABEL_W + maxCols * (NODE_W + GAP_X) + GAP_X)
    const positions = new Map<string, { x: number; y: number }>()
    const nodes: Node[] = []
    let bandTop = 0
    const maxColsFor = (width: number) => Math.max(1, Math.floor((width - LABEL_W - GAP_X) / (NODE_W + GAP_X)))
    // L0: the root scope pill.
    const l0Height = 96
    nodes.push({ id: 'band:L0', type: 'band', position: { x: 0, y: bandTop }, data: { name: 'L0 根作用域', caption: 'Cordis root', alt: false }, style: { width: canvasW, height: l0Height }, selectable: false, draggable: false })
    nodes.push({ id: 'root', type: 'root', position: { x: canvasW / 2 - 60, y: bandTop + 40 }, data: {}, selectable: false, draggable: false })
    bandTop += l0Height
    for (const meta of LAYER_META.slice(1)) {
      // Same-scope members sit in adjacent columns so a scope container only
      // ever wraps its own members (see scopeBoxes).
      const members = [...byLayer.get(meta.layer) ?? []]
        .sort((a, b) => (a.scopeId === 'root' ? 0 : 1) - (b.scopeId === 'root' ? 0 : 1) || a.scopeId.localeCompare(b.scopeId))
      const cols = maxColsFor(canvasW)
      const baseHeight = Math.max(Math.ceil(Math.max(members.length, 1) / cols) * ROW_H + BAND_PAD_TOP + BAND_PAD_BOTTOM, 96)
      // Reserve badge room only for bands that actually hold badges (data view).
      const hasBadges = layer === 'data' && (flow?.badges.some(badge => (layers.get(badge.instanceId) ?? 1) === meta.layer) ?? false)
      const height = baseHeight + (hasBadges ? BADGE_ROOM : 0)
      nodes.push({ id: `band:L${meta.layer}`, type: 'band', position: { x: 0, y: bandTop }, data: { name: meta.name, caption: meta.caption, alt: meta.layer % 2 === 1 }, style: { width: canvasW, height }, selectable: false, draggable: false })
      members.forEach((instance, index) => {
        const col = index % cols
        const row = Math.floor(index / cols)
        // Center the row inside the band.
        const rowWidth = Math.min(members.length - row * cols, cols) * (NODE_W + GAP_X) - GAP_X
        const x = Math.max(LABEL_W, (canvasW - rowWidth) / 2) + col * (NODE_W + GAP_X)
        const y = bandTop + BAND_PAD_TOP + row * ROW_H
        positions.set(instance.id, { x, y })
        nodes.push({
          id: instance.id,
          type: 'plugin',
          position: { x, y },
          data: {
            instanceId: instance.id,
            subtitle: subtitleOf(instance, stageById),
            enabled: instance.enabled,
            plugin: snapshot.plugins[instance.id],
            selected: instance.id === selectedInstanceId,
            isNew: addedIds.has(instance.id),
            flowCurrent: flow?.highlighted.includes(instance.id) ?? false,
            lessonStages: lessonStagesOf(instance),
            openLesson: lessonStagesOf(instance) !== null ? () => onOpenLesson(instance) : null,
            select: () => onSelect(instance.id),
          } satisfies PluginNodeData,
        })
      })
      bandTop += height
    }

    // Non-root scopes as dashed containers around their members (§2.3): one
    // box per (scope, layer, row run), so a scope spread over layers no longer
    // spans the bands between and covers unrelated root-scope nodes.
    scopeBoxes({
      scopes: composition.scopes,
      instances: composition.instances,
      positions,
      layers,
      nodeWidth: NODE_W,
      nodeHeight: NODE_H,
      columnGap: GAP_X,
      padX: 12,
      padTop: 34,
      padBottom: 26,
    }).forEach((box, index) => {
      nodes.push({
        id: `scope:${box.scopeId}:${box.layer}:${index}`,
        type: 'scope',
        position: { x: box.x, y: box.y },
        data: { label: box.scopeId, parent: box.parentId },
        style: { width: box.width, height: box.height, zIndex: -1 },
        selectable: false,
        draggable: false,
        className: 'scope-node',
      })
    })

    // Flow badges hang below their node, stacked tightly, so they never drift
    // over the canvas tools; several window records merge into one badge
    // (latest + count, merged in lib/dataflow).
    if (layer === 'data' && flow) {
      const stacked = new Map<string, number>()
      for (const badge of flow.badges) {
        const at = positions.get(badge.instanceId)
        if (!at) continue
        const slot = stacked.get(badge.instanceId) ?? 0
        stacked.set(badge.instanceId, slot + 1)
        nodes.push({
          id: badge.id,
          type: 'flowLabel',
          position: { x: at.x, y: at.y + NODE_H + 16 + slot * 24 },
          data: { label: badge.label, step: badge.step, count: badge.count, state: badge.state },
          selectable: false,
          draggable: false,
        })
      }
    }

    // Vertical edge channels: a channel at x crosses no node or badge in the
    // layers between source and target, so edges never run through cards.
    const layerOf = (id: string) => layers.get(id) ?? 1
    const nodeSpans = new Map<number, Array<readonly [number, number]>>()
    for (const [id, pos] of positions) {
      const layer = layerOf(id)
      nodeSpans.set(layer, [...nodeSpans.get(layer) ?? [], [pos.x, pos.x + NODE_W]])
    }
    const channelFor = (sourceId: string, targetId: string, taken: Array<readonly [number, number]>, clearance = 8): number | undefined => {
      const sourcePos = positions.get(sourceId)
      const targetPos = positions.get(targetId)
      if (!sourcePos || !targetPos) return undefined
      const lo = Math.min(layerOf(sourceId), layerOf(targetId))
      const hi = Math.max(layerOf(sourceId), layerOf(targetId))
      if (hi - lo < 2) return undefined
      const blocked: Array<readonly [number, number]> = [...taken]
      for (let layer = lo + 1; layer < hi; layer++) blocked.push(...nodeSpans.get(layer) ?? [])
      for (const badge of flow?.badges ?? []) {
        const at = positions.get(badge.instanceId)
        const badgeLayer = layerOf(badge.instanceId)
        if (at && badgeLayer > lo && badgeLayer < hi) blocked.push([at.x - 4, at.x + BADGE_W])
      }
      const free = (x: number) => !blocked.some(([a, b]) => x >= a - clearance && x <= b + clearance)
      const targetCenter = targetPos.x + NODE_W / 2
      const sourceCenter = sourcePos.x + NODE_W / 2
      for (const candidate of [targetCenter, sourceCenter]) if (free(candidate)) return candidate
      const sorted = [...blocked].sort((a, b) => a[0] - b[0])
      const gaps: Array<readonly [number, number]> = []
      let cursor = LABEL_W + clearance
      for (const [a, b] of sorted) {
        if (a - clearance > cursor) gaps.push([cursor, a - clearance])
        cursor = Math.max(cursor, b + clearance)
      }
      gaps.push([cursor, canvasW - clearance])
      let best = targetCenter
      let bestDistance = Infinity
      for (const [a, b] of gaps) {
        const x = Math.max(a, Math.min(b, targetCenter))
        const distance = Math.abs(x - targetCenter)
        if (distance < bestDistance) { best = x; bestDistance = distance }
      }
      return best
    }

    const edges: Edge[] = []
    const labeled = (edge: Omit<Edge, 'type'>) => ({ ...edge, type: 'labeled' }) as Edge
    if (layer === 'composition') {
      for (const instance of composition.instances) {
        if (instance.parentId && positions.has(instance.parentId)) {
          edges.push(labeled({ id: `tree:${instance.id}`, source: instance.parentId, target: instance.id, label: '子插件', className: 'edge-tree' }))
        } else if ((layers.get(instance.id) ?? 1) === 1) {
          const provides = stageById.get(instance.stageId)?.provides ?? []
          edges.push(labeled({ id: `tree:root:${instance.id}`, source: 'root', target: instance.id, label: `提供 ${provides.join(' · ') || '服务'}`, className: 'edge-tree' }))
        }
      }
    }
    if (layer === 'dependency' || layer === 'data') {
      for (const consumer of composition.instances) {
        for (const service of stageById.get(consumer.stageId)?.requires ?? []) {
          const providers = composition.instances.filter(candidate => candidate.id !== consumer.id && stageById.get(candidate.stageId)?.provides.includes(service))
          const resolved = snapshot.plugins[consumer.id]?.dependencyStatus === 'resolved' && snapshot.services[service]?.available
          for (const provider of providers) {
            if (layer === 'data') {
              // Data-flow layer: structure edges are thin, grey, unlabelled context.
              edges.push({
                id: `dep:${consumer.id}:${service}:${provider.id}`,
                source: consumer.id,
                target: provider.id,
                type: 'channel',
                className: 'edge-structure',
                sourceHandle: layerOf(consumer.id) > layerOf(provider.id) ? 'ts' : undefined,
                data: { channel: channelFor(consumer.id, provider.id, []) },
              })
            } else {
              edges.push(labeled({
                id: `dep:${consumer.id}:${service}:${provider.id}`,
                source: consumer.id,
                target: provider.id,
                label: `${resolved ? '已解析' : '声明'} ${service}`,
                className: `edge-dependency${resolved ? ' edge-resolved' : ''}`,
                data: { step: null },
              }))
            }
          }
        }
      }
    }
    if (layer === 'data' && flow) {
      const taken: Array<readonly [number, number]> = []
      for (const flowEdge of flow.edges) {
        // Data-flow edges avoid each other's channels, and their label pills
        // (wider than the line) must stay clear of every node between layers.
        const channel = channelFor(flowEdge.source, flowEdge.target, taken, flowEdge.label ? LABEL_CLEARANCE : 8)
        // Bare span: the clearance argument of later channelFor calls supplies the label width.
        if (channel !== undefined) taken.push([channel - 8, channel + 8])
        edges.push({
          id: flowEdge.id,
          source: flowEdge.source,
          target: flowEdge.target,
          type: 'channel',
          label: flowEdge.label,
          className: `edge-data--${flowEdge.state}`,
          sourceHandle: layerOf(flowEdge.source) > layerOf(flowEdge.target) ? 'ts' : undefined,
          data: { packet: flowEdge.packet, step: flowEdge.step, channel },
        })
      }
    }
    return { nodes, edges }
  }, [composition, stages, catalogLayers, snapshot, layer, flow, addedIds, lessons, selectedInstanceId, onSelect, onOpenLesson])

  return (
    <div className="tree" ref={onTreeElement} aria-label="插件树">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => onSelect(node.type === 'plugin' ? node.id : null)}
        onNodeDoubleClick={(_event, node) => {
          const instance = composition.instances.find(item => item.id === node.id)
          if (node.type === 'plugin' && instance && lessonStagesOf(lessons, instance) !== null) onOpenLesson(instance)
        }}
        onPaneClick={() => onSelect(null)}
        nodesDraggable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        fitView
        fitViewOptions={{ padding: { ...FIT_PADDING, bottom: `${barClearance}px` }, maxZoom: 1 }}
        // The default 0.5 cannot fit a four-column scope on a phone-width screen.
        minZoom={0.25}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} />
        <Controls showInteractive={false} position="top-left" />
        <FitOnResize bottom={barClearance} tree={treeElement} />
        <FitForDrawer open={drawerOpen} bottom={barClearance} tree={treeElement} />
      </ReactFlow>
    </div>
  )
}

function lessonStagesOf(lessons: LessonsResponse | null, instance: PluginInstance) {
  const lesson = lessons?.lessons.find(item => item.pluginDefinitionId === instance.definitionId)
  return lesson ? lesson.stages.length : null
}

/** ①–⑳ for window step badges; plain digits beyond that. */
const circled = (n: number) => (n >= 1 && n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `${n}`)

/**
 * Text alternative of the tree (§4, screen ③): rows grouped by layer L1–L4,
 * each with a status dot, the provides/requires subtitle, window step badges
 * for nodes the request has flowed through, and a chevron. Default view on
 * narrow screens; the same list serves keyboard/screen-reader users on wide ones.
 */
export function PluginList({ composition, stages, catalogLayers, snapshot, flow, selectedInstanceId, onSelect }: {
  composition: Composition
  stages: readonly PublicStage[]
  catalogLayers: Readonly<Record<string, PluginLayer>>
  snapshot: ViewSnapshot
  flow: RequestFlow | null
  selectedInstanceId: string | null
  onSelect(id: string | null): void
}) {
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const layers = assignLayers(composition.instances, stages, catalogLayers)
  const flowSteps = flowStepsByInstance(flow)
  return (
    <ul className="plugin-list" aria-label="插件列表">
      {LAYER_META.slice(1).map((meta) => {
        const members = composition.instances.filter(instance => (layers.get(instance.id) ?? 1) === meta.layer)
        if (!members.length) return null
        const [tag, ...nameParts] = meta.name.split(' ')
        return (
          <li key={meta.layer} className="plugin-list__group">
            <div className="plugin-list__group-head">
              <span className="plugin-list__layer-tag">{tag}</span>
              <span className="plugin-list__layer-name">{nameParts.join(' ')}</span>
              <span className="plugin-list__layer-caption">{meta.caption}</span>
            </div>
            <ul>
              {members.map((instance) => {
                const steps = flowSteps.get(instance.id) ?? []
                const selected = instance.id === selectedInstanceId
                return (
                  <li key={instance.id}>
                    <button
                      type="button"
                      className={`plugin-list__row phase-${String(snapshot.plugins[instance.id]?.phase ?? 'none')}${selected ? ' is-selected' : ''}${steps.length ? ' is-flowing' : ''}`}
                      aria-pressed={selected}
                      onClick={() => onSelect(instance.id)}
                    >
                      <span className="plugin-list__dot" aria-hidden />
                      <span className="plugin-list__text">
                        <span className="plugin-list__id">{instance.id}</span>
                        {instance.scopeId !== 'root' ? <span className="plugin-list__scope">作用域 {instance.scopeId}</span> : null}
                        <span className="plugin-list__sub">{subtitleOf(instance, stageById)}</span>
                      </span>
                      {steps.length ? (
                        <span className="plugin-list__flow" title={`本次请求流经此实例的步骤：${steps.join('、')}`}>
                          {steps.map(circled).join('')}
                        </span>
                      ) : null}
                      <span className="plugin-list__chevron" aria-hidden>›</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}
