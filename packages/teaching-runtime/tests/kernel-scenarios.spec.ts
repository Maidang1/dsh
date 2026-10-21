import { readFileSync } from 'node:fs'
import { Composition, ModelScript, Scenario } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { run, sessionTypes, requestsOf } from './helpers.ts'

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8'))
const scenario = (name: string) => Scenario.parse(fixture(`scenarios/${name}.json`))

describe('kernel lesson scenarios', () => {
  it('runs a greeting through the deterministic model', async () => {
    const result = await run({ scenario: scenario('chat-greeting') })

    expect(result.outcome).toBe('completed')
    expect(requestsOf(result, 'greeting')).toHaveLength(1)
    expect(sessionTypes(result, 's-greeting')).toContain('assistant/message')
  })

  it('cancels after request context is committed but before a model request', async () => {
    const result = await run({ scenario: scenario('chat-cancel') })

    expect(result.outcome).toBe('completed')
    expect(sessionTypes(result, 's-cancelled')).toEqual([
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'step/start',
      'system/message',
      'user/message',
      'request/header',
      'request/context',
      'step/end',
      'turn/end',
    ])
    expect(requestsOf(result, 'cancelled-greeting')).toEqual([])
  })

  it('declares and executes one calculator call without the denying tool policy', async () => {
    const composition = Composition.parse(fixture('compositions/calculator-chat.json'))
    const calculator = ModelScript.parse(fixture('model-scripts/calculator.json'))
    const result = await run({
      composition,
      scenario: scenario('tool-calculator'),
      modelScripts: { calculator },
    })

    expect(result.outcome).toBe('completed')
    expect(requestsOf(result, 'calculate')).toHaveLength(2)
    expect(requestsOf(result, 'calculate')[0]?.tools.map(tool => tool.name)).toEqual(['add'])
    expect(sessionTypes(result, 's-calculator')).toContain('tool/call')
    expect(sessionTypes(result, 's-calculator')).toContain('tool/result')
  })
})
