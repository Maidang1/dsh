/**
 * P5-02 tool-guard stages, the CTX-04 deny list, and the tool outcome
 * contracts (TOOL-02/03, EVT-01..03) — all run on the upstream kernel:
 * `@deepseek-ai/dsh-tools`' execution pipeline behind the upstream agent loop.
 * The old spec drove a project-written Tools service directly; these tests
 * drive full scenarios through `run()` and read the durable `tool/result`
 * session events, whose upstream data shape is
 * `{ turn, step, message: { role: 'tool', toolCallId, content: ContentBlock[], isError } }`.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PostToolDecision, PreToolDecision, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { TraceName } from '@harness-explorer/contracts'
import type { JsonValue, PluginPhasePayload } from '@harness-explorer/contracts'
import { describe, expect, it } from 'vitest'
import { calculatorScript, inlineStage, payloadOf, requestsOf, run, scenario, sessionEvents, toolChat, toolGuardScenario, withInline } from './helpers.ts'
import type { RunResult } from '../src/index.ts'

/** The upstream `tool/result` session event data; there is no `status` field. */
interface ToolResultData {
  turn: number
  step: number
  message: {
    role: 'tool'
    toolCallId: string
    content: Array<{ type: string; text?: string }>
    isError: boolean
  }
}

function toolResults(result: RunResult, sessionId: string): ToolResultData[] {
  return sessionEvents(result, sessionId)
    .filter(event => event.type === 'tool/result')
    .map(event => event.data as unknown as ToolResultData)
}

async function runGuard(stageId: string, config?: Record<string, unknown>) {
  const composition = toolChat()
  composition.instances = composition.instances.map(instance => instance.definitionId === 'tool-guard'
    ? { ...instance, stageId, ...config === undefined ? {} : { config: config as JsonValue } }
    : instance)
  return run({ composition, scenario: toolGuardScenario(), modelScripts: { calculator: calculatorScript() } })
}

/** Teaching checkpoint names recorded by a tool-guard stage, in firing order. */
const guardCheckpoints = (result: RunResult) => result.recorder.records
  .filter(record => record.name.startsWith('checkpoint/tool-guard:'))
  .map(record => record.name.slice('checkpoint/tool-guard:'.length))

describe('tool-guard stages on the upstream kernel (P5-02)', () => {
  it('00-observe: one listener enters, delegates and returns allow; the tool runs', async () => {
    const result = await runGuard('tool-guard@00-observe')
    expect(result.error).toBeNull()
    expect(guardCheckpoints(result)).toEqual(['audit-enter', 'audit-return'])
    const toolResult = toolResults(result, 's')[0]!
    expect(toolResult).toMatchObject({ turn: 1, step: 1 })
    // Upstream adds a message id and a { kind: 'tool', callId } source; the contract fields are these.
    expect(toolResult.message).toMatchObject({ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '3' }], isError: false })
  })

  it('01-two-layers: EVT-01 order is audit, policy, policy, audit', async () => {
    const result = await runGuard('tool-guard@01-two-layers')
    expect(result.error).toBeNull()
    expect(guardCheckpoints(result)).toEqual(['audit-enter', 'policy-enter', 'policy-return', 'audit-return'])
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ content: [{ type: 'text', text: '3' }], isError: false })
  })

  it('02-deny: EVT-02 and TOOL-03, the policy short-circuits and the body never runs', async () => {
    const result = await runGuard('tool-guard@02-deny')
    expect(result.error).toBeNull()
    expect(guardCheckpoints(result)).toEqual(['audit-enter', 'policy-enter', 'policy-deny', 'audit-return'])
    const toolResult = toolResults(result, 's')[0]!
    expect(toolResult.message).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: add is blocked by policy' }] })
    // The model reads the denial as the next request's tool message and answers from the script's denied rule.
    expect(requestsOf(result, 'ask')[1]!.messages.at(-1)).toEqual({ role: 'tool', content: 'Error: add is blocked by policy', toolCallId: 'call-1' })
    const answer = sessionEvents(result, 's').filter(event => event.type === 'assistant/message').at(-1)
    expect((answer?.data as { message: { content: unknown } }).message.content).toEqual([{ type: 'text', text: '这个工具被策略拒绝了' }])
  })

  it('02-deny: the deny list is configurable (CTX-04); an empty list lets the tool run', async () => {
    const result = await runGuard('tool-guard@02-deny', { deny: [] })
    expect(result.error).toBeNull()
    expect(result.outcome).toBe('completed')
    expect(guardCheckpoints(result)).toEqual(['audit-enter', 'policy-enter', 'policy-return', 'audit-return'])
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ content: [{ type: 'text', text: '3' }], isError: false })
  })
})

/**
 * A two-rule script: call `tool` with `args`, then answer once the loop feeds
 * back a tool message whose text is exactly `resultText`. A run that completes
 * therefore proves the model saw that exact text.
 */
function probeScript(tool: string, args: JsonValue, resultText: string) {
  return {
    id: 'probe',
    onUnmatched: 'fail' as const,
    rules: [
      { id: 'call', match: { declaredTools: [tool] }, respond: { kind: 'tool-call' as const, tool, arguments: args } },
      { id: 'after', match: { afterToolResult: resultText }, respond: { kind: 'text' as const, chunks: ['done'] } },
    ],
  }
}

/** An inline plugin registering one upstream tool, plus optional pre/post-execute listeners. */
function probeTool(name: string, execute: () => Promise<string>, listen?: (ctx: Context) => void) {
  return inlineStage(`probe-${name}`, ['tools'], {
    name: `probe-${name}`,
    // inlineStage's requires feeds the stage definition; Cordis reads inject from the plugin itself.
    inject: ['tools'],
    apply(ctx: Context) {
      ctx.tools.register(defineTool({
        name,
        description: `probe tool ${name}`,
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute,
      }))
      listen?.(ctx)
    },
  })
}

/** One tool round trip on the tool-chat composition without the tool-guard instance. */
function probeRun(script: ReturnType<typeof probeScript>, ...inline: Array<ReturnType<typeof inlineStage>>) {
  const composition = toolChat()
  composition.instances = composition.instances.filter(instance => instance.id !== 'tool-guard')
  return run({
    ...withInline(composition, ...inline),
    modelScripts: { probe: script },
    scenario: scenario([{ kind: 'input', id: 'ask', sessionId: 's', text: 'go' }], 'probe'),
  })
}

describe('tool outcomes through the upstream pipeline (TOOL-02, TOOL-03, EVT-03)', () => {
  it('invalid arguments become an error result the model can read', async () => {
    const result = await probeRun(probeScript('add', { a: 'one', b: 2 }, 'Error: invalid arguments: "a" must be a number'))
    expect(result.error).toBeNull()
    const toolResult = toolResults(result, 's')[0]!
    expect(toolResult.message).toMatchObject({
      role: 'tool',
      toolCallId: 'call-1',
      isError: true,
      content: [{ type: 'text', text: 'Error: invalid arguments: "a" must be a number' }],
    })
  })

  it('a throwing tool body becomes `Error: kaboom` with isError', async () => {
    const result = await probeRun(
      probeScript('explode', {}, 'Error: kaboom'),
      probeTool('explode', () => Promise.reject(new Error('kaboom'))),
    )
    expect(result.error).toBeNull()
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: kaboom' }] })
  })

  it('passes a pre-execute denial through post-execute without running the body', async () => {
    let executed = 0
    const seen: ToolExecutionResult[] = []
    const guard = probeTool('echo', () => {
      executed++
      return Promise.resolve('secret')
    }, (ctx) => {
      ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.resolve({ kind: 'deny', reason: 'no' }))
      ctx.on('tools/post-execute', (_exec, result, next) => {
        seen.push(JSON.parse(JSON.stringify(result)) as ToolExecutionResult)
        return next()
      })
    })
    const result = await probeRun(probeScript('echo', {}, 'Error: no'), guard)
    expect(result.error).toBeNull()
    expect(executed).toBe(0)
    // The denial is a post-result: post-execute still sees it and the model gets `Error: no`.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: no' }] })
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: no' }] })
  })

  it('lets post-execute replace the content of a successful result', async () => {
    const replace = probeTool('echo', () => Promise.resolve('secret'), (ctx) => {
      ctx.on('tools/post-execute', (): Promise<PostToolDecision> =>
        Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'replaced' }] }))
    })
    const result = await probeRun(probeScript('echo', {}, 'replaced'), replace)
    expect(result.error).toBeNull()
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: false, content: [{ type: 'text', text: 'replaced' }] })
  })

  it('lets post-execute block a result into an error carrying the feedback', async () => {
    const block = probeTool('echo', () => Promise.resolve('hi'), (ctx) => {
      ctx.on('tools/post-execute', (): Promise<PostToolDecision> =>
        Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'blocked by review' }] }))
    })
    const result = await probeRun(probeScript('echo', {}, 'blocked by review'), block)
    expect(result.error).toBeNull()
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: true, content: [{ type: 'text', text: 'blocked by review' }] })
  })

  it('turns a throwing pre-execute listener into an error result instead of rejecting the call', async () => {
    let executed = 0
    const crashing = probeTool('echo', () => {
      executed++
      return Promise.resolve('hi')
    }, (ctx) => {
      ctx.on('tools/pre-execute', (): Promise<PreToolDecision> => Promise.reject(new Error('policy crashed')))
    })
    const result = await probeRun(probeScript('echo', {}, 'Error: policy crashed'), crashing)
    expect(result.error).toBeNull()
    expect(executed).toBe(0)
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Error: policy crashed' }] })
  })
})

describe('duplicate tool registration (docs/03 §8)', () => {
  it('fails the second registrant and keeps the first tool in place', async () => {
    const registrant = (id: string, reply: string) => inlineStage(id, ['tools'], {
      name: id,
      inject: ['tools'],
      apply(ctx: Context) {
        ctx.tools.register(defineTool({
          name: 'echo',
          description: reply,
          parameters: {},
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: () => Promise.resolve(reply),
        }))
      },
    })
    const result = await probeRun(probeScript('echo', {}, 'from first'), registrant('first', 'from first'), registrant('second', 'from second'))
    expect(result.error).toBeNull()
    const phases = result.recorder.records
      .filter(record => record.name === TraceName.pluginPhase && record.instanceId === 'second')
      .map(record => payloadOf<PluginPhasePayload>(result, record))
    // The second fiber fails with the upstream duplicate error; settlement later unloads it (phase null).
    const failed = phases.find(phase => phase.phase === 'failed')
    expect(failed?.error?.message)
      .toBe('tool "echo" is already registered (for a per-agent variant, register through that agent\'s `agent.ctx` instead)')
    // The first registration stays: the request declares it and the call returns its reply.
    expect(requestsOf(result, 'ask')[0]!.tools.map(tool => tool.name)).toEqual(['add', 'echo'])
    expect(toolResults(result, 's')[0]!.message).toMatchObject({ isError: false, content: [{ type: 'text', text: 'from first' }] })
  })
})
