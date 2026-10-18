/**
 * PROMPT-01..04 contracts (docs/05-validation-and-release.md §3, §4.0), run on
 * the teaching runtime over real Cordis 4.0.5.
 */
import { TraceName } from '@harness-explorer/contracts'
import type { PluginPhasePayload, RegistrationAddPayload } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { finalView, lifecycleScenario, minimalChat, payloadOf, recordsOf, requestsOf, run, scenario } from './helpers.ts'

const SECTION_TEXT = '回答时使用短句'
const occurrences = (text: string, part: string) => text.split(part).length - 1

describe('PROMPT-01 and PROMPT-04: section registration and removal in one run', async () => {
  const result = await run({ scenario: lifecycleScenario() })

  it('completes', () => {
    expect(result.error).toBeNull()
    expect(result.outcome).toBe('completed')
  })

  it('baseline request A has no contributed text', () => {
    const [a] = requestsOf(result, 'baseline')
    expect(a?.system).toBe('你是一个助手')
  })

  it('mounting registers one section owned by the instance and sends no request', () => {
    const mount = recordsOf(result, 'mount')
    const added = mount.filter(record => record.name === TraceName.registrationAdd)
    expect(added).toHaveLength(1)
    expect(added[0]!.instanceId).toBe('prompt-contributor')
    expect(payloadOf<RegistrationAddPayload>(result, added[0]!)).toMatchObject({
      registrationId: 'prompt-section:root:lesson:style',
      kind: 'prompt-section',
      name: 'lesson:style',
      detail: { order: 100, text: SECTION_TEXT },
    })
    expect(mount.some(record => record.name === TraceName.modelRequest)).toBe(false)
  })

  it('request B contains the section exactly once, after the persona', () => {
    const [b] = requestsOf(result, 'with-section')
    expect(b?.system).toBe(`你是一个助手\n\n${SECTION_TEXT}`)
    expect(occurrences(b!.system, SECTION_TEXT)).toBe(1)
  })

  it('A and B differ only by the contributed section', () => {
    const [a] = requestsOf(result, 'baseline')
    const [b] = requestsOf(result, 'with-section')
    expect({ ...b, requestId: 'x', system: b!.system.replace(`\n\n${SECTION_TEXT}`, '') }).toEqual({ ...a, requestId: 'x' })
  })

  it('unmounting releases the registration and leaves recorded request B unchanged', () => {
    const removed = recordsOf(result, 'unmount').filter(record => record.name === TraceName.registrationRemove)
    expect(removed.map(record => payloadOf<{ registrationId: string }>(result, record).registrationId))
      .toEqual(['prompt-section:root:lesson:style'])
    expect(requestsOf(result, 'with-section')[0]!.system).toContain(SECTION_TEXT)
  })

  it('request C is restored to A', () => {
    expect(requestsOf(result, 'after-unmount')[0]!.system).toBe(requestsOf(result, 'baseline')[0]!.system)
  })

  it('remounting does not leak: the section appears once', () => {
    expect(occurrences(requestsOf(result, 'after-remount')[0]!.system, SECTION_TEXT)).toBe(1)
  })

  it('run settlement unloads every instance and leaves no registrations', () => {
    const view = finalView(result)
    expect(Object.values(view.registrations)).toEqual([])
    expect(Object.values(view.plugins).map(plugin => plugin.phase)).toEqual(Array(7).fill(null))
  })
})

describe('PROMPT-02: duplicate name in one scope', () => {
  it('fails the second contributor instead of silently overriding', async () => {
    const composition = minimalChat()
    const contributor = composition.instances.find(instance => instance.id === 'prompt-contributor')!
    composition.instances.push({ ...contributor, id: 'prompt-contributor-2', config: { text: '另一段' } })
    const result = await run({
      composition,
      scenario: scenario([
        { kind: 'mount', id: 'first', instanceId: 'prompt-contributor' },
        { kind: 'mount', id: 'second', instanceId: 'prompt-contributor-2' },
        { kind: 'input', id: 'ask', sessionId: 's', text: '你好' },
      ]),
    })
    const phases = recordsOf(result, 'second')
      .filter(record => record.name === TraceName.pluginPhase && record.instanceId === 'prompt-contributor-2')
      .map(record => payloadOf<PluginPhasePayload>(result, record))
    expect(phases.at(-1)).toMatchObject({
      phase: 'failed',
      error: { message: 'prompt section "lesson:style" is already registered' },
    })
    const added = result.recorder.records
      .filter(record => record.name === TraceName.registrationAdd)
      .filter(record => payloadOf<RegistrationAddPayload>(result, record).name === 'lesson:style')
    expect(added.map(record => record.instanceId)).toEqual(['prompt-contributor'])
    expect(requestsOf(result, 'ask')[0]!.system).toBe(`你是一个助手\n\n${SECTION_TEXT}`)
  })
})

describe('PROMPT-03: same name in a nested scope', () => {
  it('shadows the outer section only for sessions assembled in that scope', async () => {
    const composition = minimalChat()
    composition.scopes.push({ id: 'agent-b', parentId: 'root' })
    const contributor = composition.instances.find(instance => instance.id === 'prompt-contributor')!
    contributor.enabled = true
    composition.instances.push({ ...contributor, id: 'scoped-contributor', scopeId: 'agent-b', config: { text: '回答时使用英文' } })
    composition.instances.find(instance => instance.id === 'agent-loop')!.config = { sessionScopes: { 's-b': ['root', 'agent-b'] } }
    const script = {
      id: 'scoped',
      onUnmatched: 'fail' as const,
      rules: [{ id: 'any', match: { lastUserText: '你好' }, respond: { kind: 'text' as const, chunks: ['ok'] } }],
    }
    const result = await run({
      composition,
      modelScripts: { scoped: script },
      scenario: scenario([
        { kind: 'input', id: 'root-session', sessionId: 's-root', text: '你好' },
        { kind: 'input', id: 'scoped-session', sessionId: 's-b', text: '你好' },
      ], 'scoped'),
    })
    expect(result.error).toBeNull()
    expect(requestsOf(result, 'root-session')[0]!.system).toBe(`你是一个助手\n\n${SECTION_TEXT}`)
    expect(requestsOf(result, 'scoped-session')[0]!.system).toBe('你是一个助手\n\n回答时使用英文')
  })
})

describe('missing dependency (CTX-01 on the contributor)', () => {
  it('keeps the contributor pending with a traceable reason', async () => {
    const composition = minimalChat()
    composition.instances = composition.instances.filter(instance => instance.id === 'prompt-contributor')
    composition.instances[0]!.enabled = true
    const result = await run({ composition, scenario: scenario([{ kind: 'snapshot', id: 'look', label: 'look' }]) })
    const view = finalView(result)
    const phases = result.recorder.records
      .filter(record => record.name === TraceName.pluginPhase)
      .map(record => payloadOf<PluginPhasePayload>(result, record))
    expect(phases[0]).toEqual({ phase: 'pending', dependencyStatus: 'missing', reason: 'waiting for systemPrompt', error: null })
    expect(phases.some(phase => phase.phase === 'active')).toBe(false)
    expect(view.registrations).toEqual({})
  })
})
