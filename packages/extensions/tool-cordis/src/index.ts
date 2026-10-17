/** Read-only Host and Client runtime API discovery for plugin development. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CordisInspectPlatform, CordisInspectProviderView } from '@deepseek-ai/dsh-cordis-host-runner'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { presentInspectListCall, presentInspectQueryCall } from './present.ts'

export const name = 'tool-cordis'
export const inject = ['tools', 'cordisInspect']

function requireAgent(exec: ToolExecution): Agent {
  if (exec.agent === undefined) throw new Error('Cordis inspection requires an Agent-backed session')
  return exec.agent
}

/**
 * Report whether the published directory shows one method declaring a bare
 * string input, whose argument is the text itself.
 * @param providers - Complete provider directory from the inspect registry.
 * @param platform - Requested runtime platform.
 * @param providerId - Requested provider id.
 * @param methodName - Requested method name.
 * @returns True only when the directory publishes `{ "type": "string" }` for that method.
 */
function declaresStringInput(
  providers: readonly CordisInspectProviderView[],
  platform: CordisInspectPlatform,
  providerId: string,
  methodName: string,
): boolean {
  const schema = providers
    .find(candidate => candidate.platform === platform && candidate.id === providerId)
    ?.methods.find(candidate => candidate.name === methodName)?.inputSchema
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema) && schema['type'] === 'string'
}

/** Register read-only runtime inspection tools over the Host providers that
 * `@deepseek-ai/dsh-tool-cordis/host` registers once per process.
 * @param ctx Agent-scoped registration context.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'cordis_inspect_list',
    description:
      'List every Cordis Inspect Provider currently known to the Host, including local Host Providers and the latest '
      + 'manifests synchronized from the Client. Each entry includes its platform, purpose, read-only methods, and '
      + 'input/output schemas. Call this Tool before writing or configuring a plugin, then select the provider and '
      + 'method for cordis_inspect_query from its result. Do not guess names or treat an Inspect method as a business '
      + 'Service that Plugin code can call.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(_args, _exec): Promise<JsonValue> {
      return Promise.resolve({ providers: ctx.cordisInspect.list() } as unknown as JsonValue)
    },
    presentCall: presentInspectListCall,
  }))

  ctx.tools.register(defineTool({
    name: 'cordis_inspect_query',
    description:
      'Run a read-only query declared by an Inspect Provider. platform, provider, and method must come from '
      + 'cordis_inspect_list, and input must satisfy that method\'s schema. Use this Tool before writing plugin code '
      + 'to read exact Service methods, Event modes, plugin Config schemas, Tool schemas, theme tokens, or live '
      + 'Slot trees and props. Host queries run locally. A Client query waits for the first valid page response '
      + 'within the configured timeout; otherwise it reports a Client failure or asks you to reconnect and retry. '
      + 'This Tool cannot invoke business Service methods or modify the runtime.',
    parameters: {
      platform: { type: 'string', required: true, enum: ['host', 'client'], description: 'Runtime platform that owns the Provider.' },
      provider: { type: 'string', required: true, description: 'Exact Provider ID returned by cordis_inspect_list.' },
      method: { type: 'string', required: true, description: 'Exact method name declared by the Provider manifest.' },
      input: { type: 'json', description: 'Optional query input; it must satisfy the method input schema.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      // `type: 'json'` projects without a wire type, and some providers then
      // serialize the nested argument as a JSON string before validation.
      // Re-parse at this boundary, adopting only a structured result and never
      // over a method whose published schema declares a string input, where the
      // text is the argument itself. A malformed string falls through to the
      // provider's own schema error unchanged.
      let input = args.input
      if (typeof input === 'string' && !declaresStringInput(ctx.cordisInspect.list(), args.platform, args.provider, args.method)) {
        try {
          const reparsed = JSON.parse(input) as JsonValue
          if (reparsed !== null && typeof reparsed === 'object') input = reparsed
        } catch {
          /* fall through to provider validation */
        }
      }
      const data = await ctx.cordisInspect.query(
        args.platform,
        args.provider,
        args.method,
        input,
        requireAgent(exec),
        exec.signal,
      )
      return { platform: args.platform, provider: args.provider, method: args.method, data }
    },
    presentCall: presentInspectQueryCall,
  }))

}
