'use client'
/**
 * Data-flow layer of the plugin tree (docs/design/explorer-redesign.md §2.3–2.4).
 * Everything here is computed from records that exist in the trace: the request
 * window around the replay cursor, edges for effective registrations and model
 * calls, and badges attached to nodes. No relation is invented and nothing is
 * animated ahead of the cursor.
 */
import { TraceName } from '@harness-explorer/contracts'
import type { Composition, ModelRequestPayload, PluginLayer, ScenarioStep, SessionEventPayload, TraceRecord } from '@harness-explorer/contracts'
import type { RegistrationAddPayload } from '@harness-explorer/contracts'
import type { ViewSnapshot } from '@harness-explorer/trace/browser'
import type { PublicStage } from './api'
import type { RunData } from './store'

/** Layer bands of the tree canvas, top to bottom; L0 holds the root scope. */
export const LAYER_META: ReadonlyArray<{ layer: number; name: string; caption: string }> = [
  { layer: 0, name: 'L0 根作用域', caption: 'Cordis root' },
  { layer: 1, name: 'L1 基础服务', caption: '提供 sessions · systemPrompt · llm' },
  { layer: 2, name: 'L2 能力', caption: '工具注册 · 模型适配' },
  { layer: 3, name: 'L3 扩展', caption: '向下层服务贡献内容' },
  { layer: 4, name: 'L4 编排', caption: 'Agent 主循环' },
]

/**
 * Layer from dependency depth when the catalog does not declare one (§2.3):
 * no requires → L1; otherwise the deepest provider's layer + 1. The provider
 * of a service is the catalog stage with the smallest depth that provides it;
 * a dependency cycle contributes no depth instead of recursing forever.
 */
export function fallbackLayer(stage: PublicStage, stages: readonly PublicStage[]): PluginLayer {
  const depthOf = new Map<string, number>()
  const visiting = new Set<string>()
  const depth = (current: PublicStage): number => {
    const known = depthOf.get(current.id)
    if (known !== undefined) return known
    if (visiting.has(current.id)) return 0
    if (current.requires.length === 0) return 1
    visiting.add(current.id)
    let deepest = 0
    for (const service of current.requires) {
      const providers = stages.filter(candidate => candidate.provides.includes(service))
      const providerDepth = providers.length ? Math.min(...providers.map(provider => depth(provider))) : 0
      deepest = Math.max(deepest, providerDepth)
    }
    visiting.delete(current.id)
    const result = Math.min(4, Math.max(1, deepest + 1))
    depthOf.set(current.id, result)
    return result
  }
  return depth(stage) as PluginLayer
}

/** instanceId → layer (1–4), from the catalog's `layers` or the dependency-depth fallback. */
export function assignLayers(
  instances: readonly Composition['instances'][number][],
  stages: readonly PublicStage[],
  declared: Readonly<Record<string, PluginLayer>>,
): Map<string, PluginLayer> {
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const assigned = new Map<string, PluginLayer>()
  for (const instance of instances) {
    const declaredLayer = declared[instance.definitionId]
    if (declaredLayer) assigned.set(instance.id, declaredLayer)
    else {
      const stage = stageById.get(instance.stageId)
      assigned.set(instance.id, stage ? fallbackLayer(stage, stages) : 1)
    }
  }
  return assigned
}

/** First instance providing each service; the data-flow edges target these. */
export function serviceProviders(
  instances: readonly Composition['instances'][number][],
  stages: readonly PublicStage[],
): Record<string, string> {
  const stageById = new Map(stages.map(stage => [stage.id, stage]))
  const providers: Record<string, string> = {}
  for (const instance of instances) {
    for (const service of stageById.get(instance.stageId)?.provides ?? []) {
      providers[service] ??= instance.id
    }
  }
  return providers
}

export type FlowState = 'flown' | 'current' | 'pending'

export interface FlowStep {
  seq: number
  kind: TraceRecord['kind']
  name: string
  instanceId: string | null
  summary: string
  state: 'done' | 'current' | 'upcoming'
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  label: string
  /** Step number inside the window when the edge comes from a window record. */
  step: number | null
  state: FlowState
  /** Data packet resting on the edge: only the current model request/response. */
  packet: boolean
}

export interface FlowBadge {
  id: string
  instanceId: string
  step: number | null
  label: string
  /** How many window records the badge summarises; shown as `+N−1` when above 1. */
  count: number
  state: FlowState
}

export interface RequestFlow {
  /** `请求 #N` or `初始挂载` before the first input step. */
  title: string
  requestNumber: number
  /** e.g. `挂载 prompt-contributor 之后的第 2 次请求`. */
  subtitle: string
  steps: FlowStep[]
  edges: FlowEdge[]
  badges: FlowBadge[]
  /** Nodes to highlight without an edge (a model request whose record has no instanceId). */
  highlighted: string[]
  inputText: string | null
  /** Records of the window, for the step timeline in the side panel. */
  window: { startSeq: number; endSeq: number }
}

const CHECKPOINT_SUMMARY: Record<string, string> = {
  'request-prepared': '请求已组装',
  'model-responded': '收到模型响应',
}

function stepPayload(record: TraceRecord, payloads: RunData['payloads']): ScenarioStep | null {
  if (!record.payloadRef) return null
  const payload = payloads[record.payloadRef] as ScenarioStep | undefined
  return payload && typeof payload === 'object' && 'kind' in payload ? payload : null
}

function registrationPayload(record: TraceRecord, payloads: RunData['payloads']): RegistrationAddPayload | null {
  if (!record.payloadRef) return null
  return (payloads[record.payloadRef] as RegistrationAddPayload | undefined) ?? null
}

/** One line for a window record in the step timeline. */
export function summarizeRecord(record: TraceRecord, payloads: RunData['payloads']): string {
  if (record.name === TraceName.scenarioStep) {
    const step = stepPayload(record, payloads)
    if (!step) return '场景步骤'
    switch (step.kind) {
      case 'input': return `接收用户输入「${step.text}」`
      case 'mount': return `挂载 ${step.instanceId}`
      case 'unmount': return `卸载 ${step.instanceId}`
      case 'snapshot': return `快照：${step.label}`
      case 'cancel': return `取消运行（检查点 ${step.afterCheckpoint} 之后）`
    }
  }
  if (record.name === TraceName.registrationAdd) {
    const added = registrationPayload(record, payloads)
    return added ? `${added.name} · 注册 ${added.kind}` : '注册'
  }
  if (record.name === TraceName.registrationRemove) return '注销注册项'
  if (record.name.startsWith('checkpoint/')) {
    const name = record.name.slice('checkpoint/'.length)
    const summary = CHECKPOINT_SUMMARY[name.split(':')[1] ?? '']
    return summary ? `${name} · ${summary}` : name
  }
  if (record.name === TraceName.modelRequest) return '发送模型请求'
  if (record.name === TraceName.modelResponse) return '收到模型响应'
  if (record.name === TraceName.sessionEvent) {
    const payload = record.payloadRef ? (payloads[record.payloadRef] as SessionEventPayload | undefined) : undefined
    return `写入会话记录${payload ? `（${payload.type}）` : ''}`
  }
  if (record.name === TraceName.runSettle) return '运行结算：逆序卸载全部实例'
  return record.name
}

const ordinal = (n: number) => `第 ${n} 次请求`

/** Describe the scenario step before the window's input, for the panel subtitle. */
function leadIn(before: { record: TraceRecord; step: ScenarioStep } | null, requestNumber: number): string {
  if (!before) return requestNumber ? `场景开始后的${ordinal(requestNumber)}` : '第一批记录'
  const step = before.step
  const where = step.kind === 'mount' ? `挂载 ${step.instanceId} 之后`
    : step.kind === 'unmount' ? `卸载 ${step.instanceId} 之后`
      : step.kind === 'snapshot' ? `快照 ${step.label} 之后`
        : step.kind === 'input' ? '上一次请求之后'
          : '取消之后'
  return `${where}的${ordinal(requestNumber)}`
}

/**
 * The request window at the replay cursor (§2.4): from the previous
 * `scenario/step` with kind=input to the next `scenario/step`, capped at the
 * run's settlement. Before the first input the window is the initial mount.
 *
 * `instances` carries each instance's definitionId so checkpoint records whose
 * name prefix is the plugin *definition* (e.g. `checkpoint/agent-loop:…`) still
 * resolve to the instance when the two ids differ (scoped instances).
 */
export function computeRequestFlow(
  data: RunData | undefined,
  seq: number,
  snapshot: ViewSnapshot,
  providers: Record<string, string>,
  instances: ReadonlyArray<Pick<Composition['instances'][number], 'id' | 'definitionId'>>,
): RequestFlow | null {
  if (!data || data.records.length === 0) return null
  const { records, payloads } = data
  const known = new Set(instances.map(instance => instance.id))
  const byDefinition = new Map<string, string[]>()
  for (const instance of instances) {
    byDefinition.set(instance.definitionId, [...byDefinition.get(instance.definitionId) ?? [], instance.id])
  }
  const settleAt = records.findIndex(record => record.name === TraceName.runSettle)
  const limit = settleAt < 0 ? records.length : settleAt

  const stepsMeta = records.slice(0, limit)
    .map((record, index) => ({ record, index, step: record.name === TraceName.scenarioStep ? stepPayload(record, payloads) : null }))
    .filter(item => item.step !== null)
  const inputs = stepsMeta.filter(item => item.step!.kind === 'input')
  const start = [...inputs].reverse().find(item => item.record.seq <= seq) ?? null
  const startIndex = start ? start.index : 0
  const boundary = stepsMeta.find(item => item.index > startIndex)
  const endIndex = boundary ? boundary.index : limit
  const windowRecords = records.slice(startIndex, endIndex)
  const requestNumber = start ? inputs.filter(item => item.record.seq <= start.record.seq).length : 0
  const before = start
    ? (stepsMeta.filter(item => item.index < start.index).at(-1) as { record: TraceRecord; step: ScenarioStep } | undefined) ?? null
    : null

  const numberOf = new Map(windowRecords.map((record, index) => [record.seq, index + 1]))
  const stateOf = (recordSeq: number): FlowState => (recordSeq > seq ? 'pending' : recordSeq === seq ? 'current' : 'flown')
  const stepStateOf = (recordSeq: number): FlowStep['state'] => (recordSeq > seq ? 'upcoming' : recordSeq === seq ? 'current' : 'done')

  const steps: FlowStep[] = windowRecords.map(record => ({
    seq: record.seq,
    kind: record.kind,
    name: record.name,
    instanceId: record.instanceId ?? null,
    summary: summarizeRecord(record, payloads),
    state: stepStateOf(record.seq),
  }))

  const edges: FlowEdge[] = []
  const badges: FlowBadge[] = []
  const highlighted = new Set<string>()

  // Effective registrations at the cursor: contributor → service provider (§2.4 row 2).
  for (const registration of Object.values(snapshot.registrations)) {
    if (!registration.instanceId || !known.has(registration.instanceId)) continue
    const service = registration.kind === 'prompt-section' ? 'systemPrompt' : 'tools'
    const target = providers[service]
    if (!target || target === registration.instanceId || !known.has(target)) continue
    const inWindow = registration.addedAtSeq >= (start?.record.seq ?? -1) && registration.addedAtSeq < (records[endIndex]?.seq ?? Number.MAX_SAFE_INTEGER)
    edges.push({
      id: `flow:reg:${registration.registrationId}`,
      source: registration.instanceId,
      target,
      label: `registration · ${registration.name}`,
      step: inWindow ? numberOf.get(registration.addedAtSeq) ?? null : null,
      state: registration.addedAtSeq > seq ? 'pending' : registration.addedAtSeq === seq ? 'current' : 'flown',
      packet: false,
    })
  }

  // Every model request/response pair of this window is its own edge pair
  // (§2.4 row 4): initiator → llm for the request, llm → initiator for the
  // response, each with its own window step number. Only the edge whose record
  // sits exactly on the cursor carries the data packet.
  const llm = providers.llm && known.has(providers.llm) ? providers.llm : null
  const requests = windowRecords.filter(record => record.name === TraceName.modelRequest)
  const responses = windowRecords.filter(record => record.name === TraceName.modelResponse)
  const requestIdOf = (record: TraceRecord) => {
    if (!record.payloadRef) return null
    const payload = payloads[record.payloadRef] as { requestId?: unknown } | undefined
    return payload && typeof payload.requestId === 'string' ? payload.requestId : null
  }
  requests.forEach((request, index) => {
    const requestId = requestIdOf(request)
    // Pair by requestId; fall back to order when a payload is missing.
    const response = (requestId ? responses.find(candidate => requestIdOf(candidate) === requestId) : undefined) ?? (responses.length === requests.length ? responses[index] : undefined)
    if (!request.instanceId || !known.has(request.instanceId) || !llm) {
      if (request.seq <= seq && llm) highlighted.add(llm)
      return
    }
    const stateOfEdge = (edgeSeq: number): FlowState => (edgeSeq > seq ? 'pending' : edgeSeq === seq ? 'current' : 'flown')
    edges.push({
      id: `flow:req:${request.seq}`,
      source: request.instanceId,
      target: llm,
      label: 'llm/request',
      step: numberOf.get(request.seq) ?? null,
      // In flight once the request was made until the response arrives.
      state: stateOfEdge(request.seq) === 'flown' && (!response || response.seq > seq) ? 'current' : stateOfEdge(request.seq),
      packet: request.seq === seq,
    })
    if (response) {
      edges.push({
        id: `flow:res:${response.seq}`,
        source: llm,
        target: request.instanceId,
        label: 'model/response',
        step: numberOf.get(response.seq) ?? null,
        state: stateOfEdge(response.seq),
        packet: response.seq === seq,
      })
    }
  })

  // Node badges: the input under agent-loop, checkpoints beside their plugin,
  // one merged session/event badge for the session provider (latest + count).
  const sessionEvents: TraceRecord[] = []
  for (const record of windowRecords) {
    if (record.seq > seq) continue
    const step = numberOf.get(record.seq) ?? null
    if (record.name === TraceName.scenarioStep) {
      const payload = stepPayload(record, payloads)
      if (payload?.kind === 'input' && providers.agentLoop && known.has(providers.agentLoop)) {
        badges.push({ id: `flow:in:${record.seq}`, instanceId: providers.agentLoop, step, label: `input「${payload.text}」`, count: 1, state: stateOf(record.seq) })
      }
    } else if (record.name.startsWith('checkpoint/') && record.name !== TraceName.scenarioStep) {
      // The record's instanceId wins; otherwise the name prefix is the plugin
      // *definition* id, resolved through the composition (scoped instances
      // like a `scoped-contributor` instance of `prompt-contributor`).
      let target = record.instanceId && known.has(record.instanceId) ? record.instanceId : null
      if (!target) {
        const prefix = record.name.slice('checkpoint/'.length).split(':')[0]!
        if (known.has(prefix)) target = prefix
        else {
          const candidates = byDefinition.get(prefix) ?? []
          if (candidates.length > 0) target = candidates[0]!
        }
      }
      if (target) {
        badges.push({ id: `flow:cp:${record.seq}`, instanceId: target, step, label: record.name.split(':')[1] ?? record.name, count: 1, state: stateOf(record.seq) })
      }
    } else if (record.name === TraceName.sessionEvent) {
      sessionEvents.push(record)
    }
  }
  if (sessionEvents.length && providers.sessions && known.has(providers.sessions)) {
    const latest = sessionEvents.at(-1)!
    badges.push({
      id: `flow:se:${latest.seq}`,
      instanceId: providers.sessions,
      step: numberOf.get(latest.seq) ?? null,
      label: 'session/event',
      count: sessionEvents.length,
      state: stateOf(latest.seq),
    })
  }

  return {
    title: requestNumber ? `请求 #${requestNumber}` : '初始挂载',
    requestNumber,
    subtitle: leadIn(before, requestNumber),
    steps,
    edges,
    badges,
    highlighted: [...highlighted],
    inputText: start?.step && start.step.kind === 'input' ? start.step.text : null,
    window: { startSeq: records[startIndex]!.seq, endSeq: (records[endIndex]?.seq ?? records[limit - 1]!.seq + 1) - 1 },
  }
}

/**
 * Window step numbers that touched each instance up to the cursor (§4): every
 * edge endpoint and badge whose record is already flown or current, sorted.
 * The narrow list view badges flowing nodes with these.
 */
export function flowStepsByInstance(flow: RequestFlow | null): Map<string, number[]> {
  const steps = new Map<string, number[]>()
  if (!flow) return steps
  const add = (instanceId: string, step: number | null, state: FlowState) => {
    if (step === null || state === 'pending') return
    const list = steps.get(instanceId) ?? []
    if (!list.includes(step)) steps.set(instanceId, [...list, step].sort((a, b) => a - b))
  }
  for (const edge of flow.edges) {
    add(edge.source, edge.step, edge.state)
    add(edge.target, edge.step, edge.state)
  }
  for (const badge of flow.badges) add(badge.instanceId, badge.step, badge.state)
  return steps
}

/** The model/request payload of a window record, if it is one. */
export function requestPayloadOf(data: RunData, record: TraceRecord): ModelRequestPayload | null {
  if (record.name !== TraceName.modelRequest || !record.payloadRef) return null
  return (data.payloads[record.payloadRef] as ModelRequestPayload | undefined) ?? null
}

/** The model request before `seq` in the same run, for the paragraph comparison. */
export function previousRequest(data: RunData, seq: number): ModelRequestPayload | null {
  const before = data.records.filter(record => record.name === TraceName.modelRequest && record.seq < seq)
  const last = before.at(-1)
  return last ? requestPayloadOf(data, last) : null
}

export interface SystemParagraph {
  text: string
  /** Not present in the previous request. */
  added: boolean
  /** The registration whose text this paragraph is, when it is one. */
  source: { instanceId: string; registrationName: string } | null
}

/**
 * The system prompt of `request` as paragraphs, compared with the previous
 * request's. A paragraph's source is the latest registration added before the
 * request whose detail text equals it — never a guess from wording alone.
 */
export function diffSystemParagraphs(data: RunData, requestSeq: number, request: ModelRequestPayload): SystemParagraph[] {
  const previous = previousRequest(data, requestSeq)
  const before = new Set((previous?.system ?? '').split('\n\n'))
  const registrations = data.records
    .filter(record => record.name === TraceName.registrationAdd && record.seq <= requestSeq && record.instanceId)
    .map(record => ({ instanceId: record.instanceId!, added: registrationPayload(record, data.payloads) }))
    .filter(item => item.added !== null)
  return request.system.split('\n\n').map(text => {
    const source = [...registrations].reverse().find(item => (item.added!.detail as { text?: unknown })?.text === text)
    return {
      text,
      added: !before.has(text),
      source: source ? { instanceId: source.instanceId, registrationName: source.added!.name } : null,
    }
  })
}
