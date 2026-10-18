/**
 * TOOL-02, TOOL-03, EVT-01..03 on tool middleware, and P5-02: the tool-guard
 * stages run the around order they teach.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import { Composition, ModelScript, Scenario, TraceName } from '@harness-explorer/contracts'
import type { SessionEventPayload } from '@harness-explorer/contracts'
import type { ToolResult } from '@harness-explorer/teaching-plugins'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import SystemPrompt from '../../teaching-plugins/system-prompt/stages/main/index.ts'
import Tools from '../../teaching-plugins/tools/stages/main/index.ts'
import { payloadOf, run } from './helpers.ts'
import type { RunResult } from '../src/index.ts'

const fixture = (path: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/${path}`, import.meta.url), 'utf8'))
const toolChat = (): Composition => Composition.parse(fixture('compositions/tool-chat.json'))
const calculator = (): ModelScript => ModelScript.parse(fixture('model-scripts/calculator.json'))
const toolGuard = (): Scenario => Scenario.parse(fixture('scenarios/tool-guard.json'))

async function runStage(stageId: string) {
  const composition = toolChat()
  composition.instances = composition.instances.map(instance => instance.definitionId === 'tool-guard' ? { ...instance, stageId } : instance)
  return run({ composition, scenario: toolGuard(), modelScripts: { calculator: calculator() } })
}

const checkpoints = (result: RunResult) => result.recorder.records
  .filter(record => record.name.startsWith('checkpoint/tool-guard:'))
  .map(record => record.name.slice('checkpoint/tool-guard:'.length))

const sessionEvents = (result: RunResult) => result.recorder.records
  .filter(record => record.name === TraceName.sessionEvent)
  .map(record => payloadOf<SessionEventPayload>(result, record))

describe('tool-guard stages (P5-02)', () => {
  it('00-observe: one listener enters, delegates and returns allow; the tool runs', async () => {
    const result = await runStage('tool-guard@00-observe')
    expect(result.error).toBeNull()
    expect(checkpoints(result)).toEqual(['audit-enter', 'audit-return'])
    expect(sessionEvents(result).find(event => event.type === 'tool/result')?.data).toMatchObject({ status: 'ok', content: '3' })
  })

  it('01-two-layers: EVT-01 order is audit, policy, policy, audit', async () => {
    const result = await runStage('tool-guard@01-two-layers')
    expect(checkpoints(result)).toEqual(['audit-enter', 'policy-enter', 'policy-return', 'audit-return'])
  })

  it('02-deny: EVT-02 and TOOL-03, the policy short-circuits and the body never runs', async () => {
    const result = await runStage('tool-guard@02-deny')
    expect(result.error).toBeNull()
    expect(checkpoints(result)).toEqual(['audit-enter', 'policy-enter', 'policy-deny', 'audit-return'])
    const toolResult = sessionEvents(result).find(event => event.type === 'tool/result')
    expect(toolResult?.data).toMatchObject({ status: 'denied', content: 'Error: add is blocked by policy' })
    const answer = sessionEvents(result).filter(event => event.type === 'assistant/message').at(-1)
    expect(answer?.data).toMatchObject({ text: '这个工具被策略拒绝了' })
  })
})

describe('Tools.execute outcomes (TOOL-02, TOOL-03, EVT-03)', () => {
  async function tools(listeners: (ctx: Context) => void = () => {}) {
    const root = new Context()
    root.plugin(SystemPrompt as unknown as Plugin)
    root.plugin(Tools as unknown as Plugin)
    let executed = 0
    root.plugin({
      name: 'fixture',
      inject: ['tools'],
      apply(ctx: Context) {
        ctx.tools.register({
          name: 'echo',
          description: 'echo',
          parameters: {},
          validate: args => (typeof args === 'string' ? undefined : 'expects a string'),
          execute: (args) => {
            executed++
            if (args === 'boom') throw new Error('exploded')
            return String(args)
          },
        })
        listeners(ctx)
      },
    })
    await new Promise(resolve => setImmediate(resolve))
    return { service: root.get('tools') as Tools, executed: () => executed }
  }

  it('distinguishes unknown tools, invalid arguments and failures', async () => {
    const { service } = await tools()
    expect(await service.execute('missing', 'x')).toEqual({ status: 'unknown-tool', content: 'unknown tool "missing"' })
    expect(await service.execute('echo', 42)).toEqual({ status: 'invalid-arguments', content: 'expects a string' })
    expect(await service.execute('echo', 'boom')).toEqual({ status: 'failed', content: 'exploded' })
    expect(await service.execute('echo', 'hi')).toEqual({ status: 'ok', content: 'hi' })
  })

  it('passes a denial through post-execute, as upstream post-result does', async () => {
    const seen: ToolResult[] = []
    const { service, executed } = await tools((ctx) => {
      ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny' as const, reason: 'no' }))
      ctx.on('tools/post-execute', (_exec, result, next) => {
        seen.push(result)
        return next()
      })
    })
    expect(await service.execute('echo', 'hi')).toEqual({ status: 'denied', content: 'Error: no' })
    expect(executed()).toBe(0)
    expect(seen).toEqual([{ status: 'denied', content: 'Error: no' }])
  })

  it('lets post-execute replace content or block the result', async () => {
    const replaced = await tools(ctx => ctx.on('tools/post-execute', () => Promise.resolve({ kind: 'accept' as const, content: 'redacted' })))
    expect(await replaced.service.execute('echo', 'secret')).toEqual({ status: 'ok', content: 'redacted' })
    const blocked = await tools(ctx => ctx.on('tools/post-execute', () => Promise.resolve({ kind: 'block' as const, feedback: 'try again' })))
    expect(await blocked.service.execute('echo', 'hi')).toEqual({ status: 'blocked', content: 'try again' })
  })

  it('propagates a throwing pre-execute listener instead of swallowing it', async () => {
    const { service, executed } = await tools(ctx => ctx.on('tools/pre-execute', () => Promise.reject(new Error('listener failed'))))
    await expect(service.execute('echo', 'hi')).rejects.toThrow('listener failed')
    expect(executed()).toBe(0)
  })
})
