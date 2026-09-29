/**
 * The query tool normalizes one boundary: a provider that serialized the nested
 * `input` argument as JSON text still reaches the provider's own schema, and a
 * scalar parse is never adopted in place of the text the model sent. Both are
 * local-patch behavior, so this spec is what keeps a baseline replay from
 * dropping them silently.
 */
import { Context } from '@deepseek-ai/cordis'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it, onTestFinished } from 'vitest'
import * as toolCordis from '../src/index.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

/** One method with an object input, and one that declares a bare string. */
const METHODS = [
  {
    name: 'echo',
    description: 'Answers the object input it was given.',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  {
    name: 'echoText',
    description: 'Answers the string input it was given.',
    inputSchema: { type: 'string' },
    outputSchema: OUTPUT_SCHEMA,
  },
]

/** A composed Host with the tool mounted over one recording provider. */
async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(CordisInspectRegistryService, 10_000)
  const seen: unknown[] = []
  ctx.cordisInspect.register({
    manifest: { id: 'probe', description: 'Records what one query method received.', methods: METHODS },
    query: async (_method, input) => {
      seen.push(input)
      return { ok: true }
    },
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('tool-cordis-input'))
  await ctx.plugin(toolCordis)
  const call = (method: string, input: unknown) => ctx.tools.execute({
    name: 'cordis_inspect_query',
    arguments: { platform: 'host', provider: 'probe', method, input },
    callId: ToolCallId('inspect-query'),
    signal: new AbortController().signal,
    agent,
  })
  return { seen, call }
}

it('adopts a JSON object a provider serialized as text', async () => {
  const { seen, call } = await fixture()
  const result = await call('echo', '{"value":"typed"}')
  expect(result.isError).toBe(false)
  expect(seen).toEqual([{ value: 'typed' }])
})

it('leaves a malformed string to the provider schema', async () => {
  const { seen, call } = await fixture()
  const result = await call('echo', 'not json')
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('rejected input')
  expect(seen).toEqual([])
})

it('keeps a scalar parse as the text the model sent', async () => {
  const { seen, call } = await fixture()
  const result = await call('echoText', '5')
  expect(result.isError).toBe(false)
  expect(seen).toEqual(['5'])
})

it('passes an object input through unchanged', async () => {
  const { seen, call } = await fixture()
  const result = await call('echo', { value: 'direct' })
  expect(result.isError).toBe(false)
  expect(seen).toEqual([{ value: 'direct' }])
})
