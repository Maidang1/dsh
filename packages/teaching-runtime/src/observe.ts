/**
 * Read-only observation adapter. It listens to Cordis' internal events and to
 * the public events of the teaching plugins, and writes trace records. It never
 * changes call order or return values (see OBS-01).
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { TraceName } from '@harness-explorer/contracts'
import type { JsonValue, PluginPhasePayload, RegistrationAddPayload } from '@harness-explorer/contracts'
import type { Recorder } from '@harness-explorer/trace'
import type { SectionEntry, ToolEntry } from '@harness-explorer/teaching-plugins'
import { toPluginPhase } from './fiber-phase.ts'

interface Registration extends RegistrationAddPayload {
  instanceId: string | undefined
}

export class Observer {
  private readonly instanceByFiber = new WeakMap<Fiber, string>()
  private mounting: string | undefined
  private readonly registrations = new Map<string, Registration>()
  private readonly disposers: Array<() => unknown> = []
  /** Scenario step currently executing, attached to every record. */
  currentStepId: string | undefined
  /** Called after a teaching checkpoint is recorded. */
  onCheckpoint: ((name: string) => void) | undefined
  /**
   * Errors Cordis logged instead of throwing, e.g. a disposer that failed
   * during unload (fiber.ts `_unload`). The runner drains them after each
   * lifecycle operation so a failed cleanup is never reported as success.
   */
  readonly loggedErrors: Array<{ instanceId: string | undefined; message: string }> = []

  /**
   * With `recording` off nothing is observed; only the checkpoint hook that
   * drives scenario cancel steps stays attached. OBS-01 compares both modes.
   */
  constructor(
    private readonly root: Context,
    private readonly recorder: Recorder,
    private readonly watchedServices: ReadonlySet<string>,
    recording = true,
  ) {
    if (recording) this.listen()
    else this.disposers.push(root.on('explorer/checkpoint', name => this.onCheckpoint?.(name)))
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

    keep(root.on('session/event', (sessionId, event) => {
      this.record({
        kind: 'session',
        name: TraceName.sessionEvent,
        sessionId,
        turnId: event.turnId,
        ...event.stepId ? { stepId: event.stepId } : {},
        payload: { sessionId, type: event.type, data: event.data },
      })
    }))

    keep(root.on('explorer/checkpoint', (name, data) => {
      this.record({ kind: 'checkpoint', name: `checkpoint/${name}`, payload: data })
      this.onCheckpoint?.(name)
    }))

    keep(root.on('llm/request', (request) => {
      this.record({ kind: 'data', name: TraceName.modelRequest, payload: request })
    }))
    keep(root.on('llm/response', (requestId, response) => {
      this.record({ kind: 'data', name: TraceName.modelResponse, payload: { requestId, ...response } })
    }))
  }

  private serviceChanged(name: string, value: unknown, provider: Context) {
    if (!this.watchedServices.has(name)) return
    this.record({
      kind: 'service',
      name: TraceName.serviceChange,
      payload: { name, providerInstanceId: this.instanceOf(provider.fiber) ?? null, available: value !== undefined },
    })
    if (value === undefined) {
      if (name === 'systemPrompt') this.syncRegistrations('prompt-section')
      if (name === 'tools') this.syncRegistrations('tool')
    }
  }

  private currentRegistrations(kind: Registration['kind']): Map<string, Registration> {
    const current = new Map<string, Registration>()
    if (kind === 'prompt-section') {
      for (const entry of (this.root.get('systemPrompt')?.entries() ?? []) as SectionEntry[]) {
        const { scopeId, section } = entry
        const registrationId = `prompt-section:${scopeId}:${section.name}`
        current.set(registrationId, {
          registrationId,
          kind,
          name: section.name,
          scopeId,
          detail: { order: section.order, text: section.text },
          instanceId: this.instanceOf(entry.owner),
        })
      }
    } else if (kind === 'tool') {
      for (const entry of (this.root.get('tools')?.entries() ?? []) as ToolEntry[]) {
        const { name, description, parameters } = entry.definition
        const registrationId = `tool:${name}`
        current.set(registrationId, {
          registrationId,
          kind,
          name,
          scopeId: 'root',
          detail: { description, parameters: structuredClone(parameters) as JsonValue },
          instanceId: this.instanceOf(entry.owner),
        })
      }
    }
    return current
  }

  /** Diff the service's registrations against what was last recorded. */
  private syncRegistrations(kind: Registration['kind']) {
    const current = this.currentRegistrations(kind)
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
      this.registrations.set(registrationId, registration)
      const { instanceId, ...payload } = registration
      this.record({ kind: 'data', name: TraceName.registrationAdd, ...instanceId ? { instanceId } : {}, payload })
    }
  }
}
