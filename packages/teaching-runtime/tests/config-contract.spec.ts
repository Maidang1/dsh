/**
 * Plugin config (docs/02 §8): values are validated by Cordis against each
 * stage's `Config` schema, as upstream services declare them, and keys a stage
 * does not support are refused before anything is mounted.
 */
import { TraceName } from '@harness-explorer/contracts'
import type { PluginPhasePayload } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { IDENTITY, lifecycleScenario, minimalChat, payloadOf, requestsOf, run } from './helpers.ts'

const withConfig = (instanceId: string, config: Record<string, unknown>) => {
  const composition = minimalChat()
  composition.instances = composition.instances.map(instance => (instance.id === instanceId ? { ...instance, config: config as never } : instance))
  return composition
}

describe('plugin config', () => {
  it('applies a supported config', async () => {
    const result = await run({ composition: withConfig('prompt-contributor', { text: '只用一句话' }), scenario: lifecycleScenario() })
    expect(result.outcome).toBe('completed')
    expect(requestsOf(result, 'with-section')[0]!.system).toContain('只用一句话')
  })

  it('applies an upstream system-prompt config', async () => {
    const result = await run({ composition: withConfig('system-prompt', { includeHarnessIdentity: false, personaPrefix: '你是一个助手' }), scenario: lifecycleScenario() })
    expect(result.outcome).toBe('completed')
    const system = requestsOf(result, 'with-section')[0]!.system
    expect(system).not.toContain(IDENTITY)
    expect(system).toContain('你是一个助手')
  })

  it.each([
    ['a typo', 'prompt-contributor', { txt: '只用一句话' }, /"prompt-contributor" \(prompt-contributor@02-section\) does not support config "txt"; supported: name, order, text/],
    ['the key the old teaching subset used instead of the upstream ones', 'system-prompt', { persona: '你是一个助手' }, /"system-prompt" \(system-prompt@0\.2\.1-rc\.2\) does not support config "persona"; supported: includeHarnessIdentity, includeRuntimeContext, personaPrefix, personaSuffix, toolOrder/],
    ['any key for a stage without config', 'session', { idleTtl: 60 }, /"session" \(session@0\.2\.1-rc\.2\) does not support config "idleTtl"; supported: none/],
  ])('refuses %s before mounting anything', async (_name, instanceId, config, message) => {
    const records: string[] = []
    await expect(run({ composition: withConfig(instanceId, config), scenario: lifecycleScenario(), onRecord: record => records.push(record.name) }))
      .rejects.toThrow(message)
    expect(records).not.toContain(TraceName.pluginPhase)
  })

  it('fails the instance through Cordis when a value has the wrong type', async () => {
    const result = await run({ composition: withConfig('prompt-contributor', { order: 'first' }), scenario: lifecycleScenario() })
    const phases = result.recorder.records
      .filter(record => record.name === TraceName.pluginPhase && record.instanceId === 'prompt-contributor')
      .map(record => payloadOf<PluginPhasePayload>(result, record))
    expect(phases.find(phase => phase.phase === 'failed')?.error?.name).toBe('ValidationError')
    expect(requestsOf(result, 'with-section')[0]!.system).not.toContain('回答时使用短句')
  })
})
