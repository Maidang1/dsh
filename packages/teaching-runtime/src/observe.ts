/**
 * Read-only observation adapter over the upstream kernel. It listens to
 * Cordis' internal events, the public events of the upstream services and the
 * teaching checkpoints, and writes trace records. It never changes call order
 * or return values (OBS-01): the one waterfall it joins, `llm/stream`, passes
 * every chunk through unchanged.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { ROOT_SCOPE, TraceName } from '@harness-explorer/contracts'
import type { JsonValue, ModelMessage, ModelRequestPayload, PluginPhasePayload, RegistrationAddPayload } from '@harness-explorer/contracts'
import type {} from '@harness-explorer/teaching-plugins'
import type { Recorder } from '@harness-explorer/trace'
import { toPluginPhase } from './fiber-phase.ts'

interface Registration extends RegistrationAddPayload {
  instanceId: string | undefined
}

type RegistrationKind = 'prompt-section' | 'tool'

/** The part of upstream `ScopedLayers` the observer reads: the global layer and an exact scope's own layer. */
interface Layers<L> {
  readonly global: L
  peek(scope: object | undefined): L | undefined
}
interface Entries<V> {
  entries(): IterableIterator<[string, V]>
}
type PromptLayers = Layers<{ sections: Entries<{ name: string; order: number; text: string }> }>
type ToolLayers = Layers<{ tools: Entries<{ name: string; description: string; parameters: unknown }> }>

/** Effect label of each registration kind, as upstream passes it to `ctx.effect()`. */
const EFFECT_LABEL: Record<RegistrationKind, string> = {
  'prompt-section': 'systemPrompt.section()',
  'tool': 'tools.register()',
}

interface EffectMeta {
  label: string
  children: EffectMeta[]
}

const countEffects = (effects: readonly EffectMeta[], label: string): number =>
  effects.reduce((sum, effect) => sum + (effect.label === label ? 1 : 0) + countEffects(effect.children, label), 0)

/** Detach a value from live objects; payloads must be plain JSON. */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value ?? null)) as JsonValue

function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block: { type?: string; text?: string }) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('')
}

function parseArguments(text: string): JsonValue {
  try {
    return json(JSON.parse(text))
  } catch {
    return text
  }
}

/** The upstream request in the explorer's request vocabulary, for request lists and diffs. */
export function modelRequestPayload(requestId: string, options: GenerateOptions): ModelRequestPayload {
  const system: string[] = []
  const messages: ModelMessage[] = []
  for (const message of options.messages as ReadonlyArray<{ role: string; content: unknown; toolCallId?: string }>) {
    if (message.role === 'system') {
      system.push(blockText(message.content))
      continue
    }
    const toolCalls = Array.isArray(message.content)
      ? message.content.filter((block: { type?: string }) => block.type === 'tool-call')
        .map((block: { id: string; name: string; arguments: string }) => ({ id: String(block.id), name: block.name, arguments: parseArguments(block.arguments) }))
      : []
    messages.push({
      role: message.role as ModelMessage['role'],
      content: blockText(message.content),
      ...message.toolCallId ? { toolCallId: String(message.toolCallId) } : {},
      ...toolCalls.length ? { toolCalls } : {},
    })
  }
  return {
    requestId,
    provider: options.provider,
    model: options.model,
    system: system.join('\n\n'),
    messages,
    tools: (options.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: json(tool.parameters) })),
  }
}

export class Observer {
  private readonly instanceByFiber = new WeakMap<Fiber, string>()
  private readonly fibers = new Set<Fiber>()
  private mounting: string | undefined
  private readonly registrations = new Map<string, Registration>()
  /** Live effects per fiber and registration kind, at the last sync. */
  private readonly effectCounts = new Map<RegistrationKind, Map<Fiber, number>>()
  private readonly disposers: Array<() => unknown> = []
  private readonly turns = new Map<string, { turn?: number | undefined; step?: number | undefined }>()
  private requestCounter = 0
  /** Scenario step currently executing, attached to every record. */
  currentStepId: string | undefined
  /** Called after a teaching checkpoint is recorded. */
  onCheckpoint: ((name: string) => void) | undefined
  /** Called after an upstream session event is recorded; scenario cancel steps can wait for one. */
  onSessionEvent: ((sessionId: string, type: string) => void) | undefined
  /**
   * Errors Cordis logged instead of throwing, e.g. a disposer that failed
   * during unload (fiber.ts `_unload`). The runner drains them after each
   * lifecycle operation so a failed cleanup is never reported as success.
   */
  readonly loggedErrors: Array<{ instanceId: string | undefined; message: string }> = []

  /**
   * With `recording` off nothing is observed; only the hooks that drive
   * scenario cancel steps stay attached. OBS-01 compares both modes.
   * `scopes` names the composition's scope keys, so registrations in a
   * scope's own layer are attributed to that scope.
   */
  constructor(
    private readonly root: Context,
    private readonly recorder: Recorder,
    private readonly watchedServices: ReadonlySet<string>,
    recording = true,
    private readonly scopes: ReadonlyMap<string, object> = new Map(),
  ) {
    if (recording) {
      this.listen()
    } else {
      this.disposers.push(root.on('explorer/checkpoint', name => this.onCheckpoint?.(name)))
      this.disposers.push(root.on('session/event', (session, event) => this.onSessionEvent?.(String(session.id), event.type)))
    }
    this.disposers.push(root.logger.exporter({
      export: (message) => {
        if (message.type !== 'error') return
        const reason = message.args[0]
        const instanceId = this.instanceOf(message.fiber?.deref())
        const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
        this.loggedErrors.push({ instanceId, message: text })
        if (recording) {
          this.record({ kind: 'diagnostic', name: TraceName.diagnostic, ...instanceId ? { instanceId } : {}, payload: { level: 'error', message: `Cordis logged: ${text}` } })
        }
      },
    }))
  }

  drainLoggedErrors() {
    return this.loggedErrors.splice(0)
  }

  /** Mount through this so the fiber is attributed to the composition instance. */
  mount<T>(instanceId: string, mount: () => T): T {
    this.mounting = instanceId
    try {
      return mount()
    } finally {
      this.mounting = undefined
    }
  }

  instanceOf(fiber: Fiber | undefined): string | undefined {
    return fiber ? this.instanceByFiber.get(fiber) : undefined
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private record(input: Parameters<Recorder['record']>[0]) {
    return this.recorder.record(this.currentStepId ? { scenarioStepId: this.currentStepId, ...input } : input)
  }

  private phase(fiber: Fiber, instanceId: string) {
    const missing = Object.keys(fiber.inject).filter(name => fiber.parent.get(name) === undefined)
    const error = (fiber as unknown as { _error?: unknown })._error
    const payload: PluginPhasePayload = {
      phase: toPluginPhase(fiber.state),
      dependencyStatus: Object.keys(fiber.inject).length === 0 ? 'resolved' : missing.length ? 'missing' : 'resolved',
      reason: missing.length ? `waiting for ${missing.join(', ')}` : null,
      error: error instanceof Error ? { name: error.name, message: error.message } : null,
    }
    this.record({ kind: 'lifecycle', name: TraceName.pluginPhase, instanceId, payload })
  }

  private listen() {
    const { root } = this
    const keep = (dispose: () => unknown) => this.disposers.push(dispose)

    keep(root.on('internal/plugin', (fiber) => {
      if (this.mounting === undefined || fiber.uid === null || this.instanceByFiber.has(fiber)) return
      this.instanceByFiber.set(fiber, this.mounting)
      this.fibers.add(fiber)
      const instanceId = this.mounting
      this.mounting = undefined
      this.phase(fiber, instanceId)
    }))

    keep(root.on('internal/status', (fiber) => {
      const instanceId = this.instanceByFiber.get(fiber)
      if (instanceId) this.phase(fiber, instanceId)
    }))

    const observer = this
    keep(root.on('internal/service', function (this: Context, name, value) {
      // Cordis calls this listener with the providing context as `this`.
      observer.serviceChanged(name, value, this)
    }))

    keep(root.on('system-prompt/change', () => this.syncRegistrations('prompt-section')))
    keep(root.on('tools/change', () => this.syncRegistrations('tool')))

    keep(root.on('session/event', (session, event) => this.sessionEvent(session, event)))

    keep(root.on('explorer/checkpoint', (name, data) => {
      this.record({ kind: 'checkpoint', name: `checkpoint/${name}`, payload: json(data) })
      this.onCheckpoint?.(name)
    }))

    // Registered before any plugin mounts, so it is the outermost listener and sees each loop request once.
    keep(root.on('llm/stream', (options, next) => this.observeStream(options, next)))
  }

  private async* observeStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const requestId = `request-${++this.requestCounter}`
    this.record({ kind: 'data', name: TraceName.modelRequest, payload: modelRequestPayload(requestId, options) })
    let text = ''
    const toolCalls: Array<{ id: string; name: string; arguments: JsonValue }> = []
    let finish: JsonValue = null
    let failure: { name: string; message: string } | null = null
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          toolCalls.push({ id: String(chunk.block.id), name: chunk.block.name, arguments: parseArguments(chunk.block.arguments) })
        } else if (chunk.type === 'finish') finish = json(chunk.reason)
        yield chunk
      }
    } catch (error) {
      failure = error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) }
      throw error
    } finally {
      this.record({ kind: 'data', name: TraceName.modelResponse, payload: { requestId, text, toolCalls, finish, error: failure } })
    }
  }

  /**
   * Upstream session events carry turn and step numbers in their data but no
   * ids; follow each session's open turn and step so every event is grouped.
   */
  private sessionEvent(session: Session, event: SessionEvent) {
    const sessionId = String(session.id)
    const position: { turn?: number | undefined; step?: number | undefined } = this.turns.get(sessionId) ?? {}
    this.turns.set(sessionId, position)
    const data = event.data as { turn?: unknown; step?: unknown }
    if (event.type === 'turn/start' && typeof data.turn === 'number') position.turn = data.turn
    if (event.type === 'step/start' && typeof data.step === 'number') position.step = data.step
    const turnId = position.turn !== undefined ? `${sessionId}:turn-${position.turn}` : undefined
    const stepId = turnId && position.step !== undefined ? `${turnId}:step-${position.step}` : undefined
    this.record({
      kind: 'session',
      name: TraceName.sessionEvent,
      sessionId,
      ...turnId ? { turnId } : {},
      ...stepId ? { stepId } : {},
      payload: { sessionId, type: event.type, data: json(event.data) },
    })
    if (event.type === 'step/end') position.step = undefined
    if (event.type === 'turn/end') {
      position.turn = undefined
      position.step = undefined
    }
    this.onSessionEvent?.(sessionId, event.type)
  }

  private serviceChanged(name: string, value: unknown, provider: Context) {
    const providerInstanceId = this.instanceOf(provider.fiber) ?? null
    // Undeclared services of a mounted instance are recorded too, so a stage
    // whose catalog `provides` is wrong shows up instead of being invisible.
    if (!this.watchedServices.has(name) && providerInstanceId === null) return
    this.record({
      kind: 'service',
      name: TraceName.serviceChange,
      payload: { name, providerInstanceId, available: value !== undefined },
    })
    // A service's own registrations happen before it is published; read them when it appears.
    if (name === 'systemPrompt') this.syncRegistrations('prompt-section')
    if (name === 'tools') this.syncRegistrations('tool')
  }

  /**
   * Upstream registries keep no owner per entry, but each registration is a
   * labelled Cordis effect on the registering fiber (`fiber.getEffects()`).
   * The fiber whose count of that label grew since the last sync owns what is new.
   */
  private grownOwner(kind: RegistrationKind): string | undefined {
    const previous = this.effectCounts.get(kind) ?? new Map<Fiber, number>()
    const current = new Map<Fiber, number>()
    const grown: Fiber[] = []
    for (const fiber of this.fibers) {
      if (fiber.uid === null) continue
      const count = countEffects(fiber.getEffects() as EffectMeta[], EFFECT_LABEL[kind])
      current.set(fiber, count)
      if (count > (previous.get(fiber) ?? 0)) grown.push(fiber)
    }
    this.effectCounts.set(kind, current)
    return grown.length === 1 ? this.instanceOf(grown[0]) : undefined
  }

  private layersOf(kind: RegistrationKind): PromptLayers | ToolLayers | undefined {
    // `layers` is a private field of the upstream services; it is only read here.
    const service = kind === 'prompt-section' ? this.root.get('systemPrompt') : this.root.get('tools')
    return (service as { layers?: PromptLayers | ToolLayers } | undefined)?.layers
  }

  private currentRegistrations(kind: RegistrationKind): Map<string, Omit<Registration, 'instanceId'>> {
    const current = new Map<string, Omit<Registration, 'instanceId'>>()
    const layers = this.layersOf(kind)
    if (!layers) return current
    const scoped: Array<[string, object | undefined]> = [[ROOT_SCOPE, undefined], ...this.scopes]
    for (const [scopeId, key] of scoped) {
      const layer = key === undefined ? layers.global : layers.peek(key)
      if (!layer) continue
      if (kind === 'prompt-section') {
        for (const [name, section] of (layer as PromptLayers['global']).sections.entries()) {
          const registrationId = `prompt-section:${scopeId}:${name}`
          current.set(registrationId, { registrationId, kind, name, scopeId, detail: { order: section.order, text: section.text } })
        }
      } else {
        for (const [name, tool] of (layer as ToolLayers['global']).tools.entries()) {
          const registrationId = `tool:${scopeId}:${name}`
          current.set(registrationId, { registrationId, kind, name, scopeId, detail: { description: tool.description, parameters: json(tool.parameters) } })
        }
      }
    }
    return current
  }

  /** Diff the service's registrations against what was last recorded. */
  private syncRegistrations(kind: RegistrationKind) {
    const current = this.currentRegistrations(kind)
    // Effects are only compared once the registry is readable, so growth before publication is not lost.
    const owner = this.layersOf(kind) ? this.grownOwner(kind) : undefined
    for (const [registrationId, previous] of this.registrations) {
      if (previous.kind !== kind || current.has(registrationId)) continue
      this.registrations.delete(registrationId)
      this.record({
        kind: 'data',
        name: TraceName.registrationRemove,
        ...previous.instanceId ? { instanceId: previous.instanceId } : {},
        payload: { registrationId },
      })
    }
    for (const [registrationId, registration] of current) {
      if (this.registrations.has(registrationId)) continue
      this.registrations.set(registrationId, { ...registration, instanceId: owner })
      this.record({ kind: 'data', name: TraceName.registrationAdd, ...owner ? { instanceId: owner } : {}, payload: registration })
    }
  }
}
