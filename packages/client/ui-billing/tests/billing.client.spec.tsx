// @vitest-environment jsdom
/**
 * ui-billing browser half: the two composer-dock cost pills, the per-turn cost
 * row, the Billing settings page, and the plugin's three slot registrations
 * against the real SlotRegistry (fiber teardown must remove all of them).
 *
 * The components take the framework's seats as plain props, so these specs
 * drive them directly and assert what a reader sees: amounts, route rows, and
 * the writes a Save queues.
 */
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import {
  makeTranslate, stubSettingsScope, TestRemote, type StubSettingsScope,
} from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { DEFAULT_CURRENCY, NS, type BillingSettings } from '../src/settings.ts'
import { SessionCostMeter, currencyOf, freshness, groupSteps, useScopeSnapshot } from '../src/client/CostMeter.tsx'
import { TurnCostMeter, attemptsOf } from '../src/client/TurnCostMeter.tsx'
import { BillingSection } from '../src/client/SettingsSection.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(en, zh)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function snapshot(partial: Partial<SettingsScopeSnapshot<BillingSettings>> = {}): SettingsScopeSnapshot<BillingSettings> {
  return {
    status: 'ready',
    value: { currency: DEFAULT_CURRENCY, models: {}, cache: null, cacheError: null },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...partial,
  }
}

/** A projection seat over one fixed value. */
function projection(values: Record<string, unknown>) {
  return (key: string): unknown => values[key]
}

const FLASH_RATES = { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }

describe('currency selection', () => {
  it('uses the account currency, then the configured one', () => {
    expect(currencyOf({ total: 1, currency: 'USD', available: true, at: 0 }, 'CNY')).toBe('USD')
    expect(currencyOf(null, 'EUR')).toBe('EUR')
  })
})

describe('session cost pill', () => {
  it('renders nothing before any usage or balance exists', () => {
    const stub = stubSettingsScope<BillingSettings>()
    const { container } = render(
      <SessionCostMeter useProjection={projection({}) as never} scope={stub.scope} t={t} />,
    )
    expect(container.innerHTML).toBe('')
  })

  it('prices the running total and shows the account balance beside it', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 12.75, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('¥18.00 this session')).toBeDefined()
    expect(screen.getByText('Balance ¥12.75')).toBeDefined()
    expect(screen.getByLabelText('¥18.00 this session')).toBeDefined()
  })

  it('reprices when a rate is edited', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('¥13.50 this session')).toBeDefined()
    await act(async () => {
      stub.publish(snapshot({
        value: {
          currency: 'CNY',
          models: { 'bai/glm-5.3-flash': { ...FLASH_RATES, output: 20 } },
          cache: null,
          cacheError: null,
        },
      }))
    })
    expect(screen.getByText('¥20.00 this session')).toBeDefined()
  })

  it('names an unpriced route instead of inventing a total', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'x', model: 'y' }, next: null },
        }) as never}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('- this session')).toBeDefined()
    fireEvent.click(screen.getByLabelText('- this session'))
    expect(screen.getByText('No route has rates yet, so no cost can be computed. Set them in Settings → Billing.')).toBeDefined()
    expect(screen.getByText('x/y')).toBeDefined()
    expect(screen.getByText('No rates configured')).toBeDefined()
  })

  it('shows the balance dialog with freshness and a recorded failure', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: {},
        cache: { total: 3, currency: 'USD', available: false, at: Date.now() - 120_000 },
        cacheError: 'balance request failed: HTTP 401',
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        scope={stub.scope}
        t={t}
      />,
    )
    fireEvent.click(screen.getByLabelText('Balance $3.00'))
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek account balance' })
    expect(within(dialog).getByText('Insufficient balance')).toBeDefined()
    expect(within(dialog).getByText('2 min ago')).toBeDefined()
    expect(within(dialog).getByText('Balance read failed: balance request failed: HTTP 401')).toBeDefined()
  })

  it('closes on Escape and on an outside pointer', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({ value: { currency: 'CNY', models: {}, cache: null, cacheError: 'x' } }))
    render(<SessionCostMeter useProjection={projection({}) as never} scope={stub.scope} t={t} />)
    const trigger = screen.getByLabelText('Balance -')
    fireEvent.click(trigger)
    // The panel is still hidden until the placement clamp measures it, which
    // jsdom reports as zero-size geometry, so the role query includes it.
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance', hidden: true })).toBeDefined()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance', hidden: true })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
  })

  it('keeps one dialog open at a time', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'a/b': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        scope={stub.scope}
        t={t}
      />,
    )
    fireEvent.click(screen.getByLabelText('¥4.50 this session'))
    expect(screen.getByRole('dialog', { name: 'Session cost' })).toBeDefined()
    fireEvent.click(screen.getByLabelText('Balance ¥1.00'))
    expect(screen.queryByRole('dialog', { name: 'Session cost' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance' })).toBeDefined()
  })
})

describe('scope subscription', () => {
  it('follows published snapshots and unsubscribes on unmount', () => {
    const stub = stubSettingsScope<BillingSettings>()
    function Probe(): React.ReactNode {
      const current = useScopeSnapshot(stub.scope)
      return <span>{current.value?.currency ?? 'none'}</span>
    }
    const { unmount } = render(<Probe />)
    expect(screen.getByText('none')).toBeDefined()
    act(() => { stub.publish(snapshot({ value: { currency: 'USD', models: {}, cache: null, cacheError: null } })) })
    expect(screen.getByText('USD')).toBeDefined()
    expect(stub.listenerCount()).toBe(1)
    unmount()
    expect(stub.listenerCount()).toBe(0)
  })
})

describe('turn cost row', () => {
  const nodes = [
    {
      key: 'turn-tail', kind: 'turn-tail', target: 'chat', anchorSeq: 3, location: { kind: 'session' },
      visibility: 'visible', id: 'turn-tail',
      data: {
        turn: 1,
        tokenUsage: {
          uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          routes: [{ provider: 'bai', model: 'glm-5.3-flash' }],
        },
      },
    },
    {
      key: 'assistant-1', kind: 'assistant', target: 'chat', anchorSeq: 2, location: { kind: 'session' },
      visibility: 'visible', id: 'assistant-1',
      data: {
        turn: 1,
        finalNode: {
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          provenance: { provider: 'bai', model: 'glm-5.3-flash' },
        },
      },
    },
  ] as unknown as readonly ChatConversationViewNode[]

  function useChat<T>(select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => T): T {
    return select({ nodes: { values: () => nodes } })
  }

  /** Projection seat for the turns whose payload the loaded window lost. */
  const noProjection = ((key: string): unknown => key === 'tokenUsage'
    ? { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    : undefined) as never

  it('reads each attempt of the turn', () => {
    expect(attemptsOf(nodes, 1)).toEqual([{
      route: 'bai/glm-5.3-flash',
      buckets: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }])
    expect(attemptsOf(nodes, 2)).toEqual([])
  })

  it('renders the turn total and breaks it down per route', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 1, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    render(
      <TurnCostMeter
        owner={{ turn: { turn: 1 }, seq: 3, openFile: vi.fn() } as never}
        useChat={useChat as never}
        useProjection={noProjection}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('¥18.00 this turn')).toBeDefined()
    fireEvent.click(screen.getByLabelText('¥18.00 this turn'))
    const dialog = screen.getByRole('dialog', { name: 'Turn cost' })
    const rows = dialog.querySelector('[data-billing-turn-routes]')
    expect(rows?.textContent).toContain('bai/glm-5.3-flash')
    expect(rows?.textContent).toContain('¥18.00')
    expect(within(dialog).getByText('bai/glm-5.3-flash: 0.15 / 4.5 / 13.5')).toBeDefined()
  })

  it('prices a turn whose payload the loaded window lost', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const projected = ((key: string): unknown => key === 'tokenUsage'
      ? { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      : key === 'modelSelection'
        ? { lastUsed: null, next: { provider: 'bai', model: 'glm-5.3-flash' } }
        : undefined) as never
    render(
      <TurnCostMeter
        owner={{ turn: { turn: 9 }, seq: 3, openFile: vi.fn() } as never}
        useChat={useChat as never}
        useProjection={projected}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('¥4.50 this turn')).toBeDefined()
  })

  it('reports an unpriced turn and stays silent without accounting', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const { unmount } = render(
      <TurnCostMeter
        owner={{ turn: { turn: 1 }, seq: 3, openFile: vi.fn() } as never}
        useChat={useChat as never}
        useProjection={noProjection}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(screen.getByText('- this turn')).toBeDefined()
    fireEvent.click(screen.getByLabelText('- this turn'))
    expect(screen.getByText('No rates configured; this turn is not billed')).toBeDefined()
    unmount()

    const empty = render(
      <TurnCostMeter
        owner={{ turn: { turn: 9 }, seq: 3, openFile: vi.fn() } as never}
        useChat={useChat as never}
        useProjection={noProjection}
        scope={stub.scope}
        t={t}
      />,
    )
    expect(empty.container.innerHTML).toBe('')
  })
})

describe('settings page', () => {
  /** A Remote double carrying the provider directory the page reads. */
  function remoteDouble(): { llm: Record<string, unknown> } {
    return {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [{ id: 'bai', name: 'BAI' }] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [{ provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] }],
        }),
      },
    }
  }

  /**
   * The describe mirror's answer with `bai` in the user layer, which is what
   * makes the page treat it as a provider the user configured.
   */
  function baiDirectory(overrides: { value?: unknown; user?: unknown } = {}) {
    const profile = { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }] }
    return {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [{
            ns: 'llm-pi-ai',
            value: overrides.value ?? { providers: { bai: profile } },
            user: overrides.user ?? { providers: { bai: profile } },
          }],
        },
      }),
    }
  }

  function contextDouble(
    remote: { llm: Record<string, unknown> },
    describe: unknown,
  ): Context {
    const ctx = new Context()
    // The real double also provides `remote.<namespace>`, which is what a
    // plugin injecting `remote.llm` waits on.
    new TestRemote(ctx, remote)
    ctx.provide('settingsScope', { describe: () => describe } as never)
    return ctx
  }

  it('lists the configured models with their stored rates', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: { total: 12.75, currency: 'CNY', available: true, at: Date.now() },
        cacheError: null,
      },
    }))
    const ctx = contextDouble(remoteDouble(), baiDirectory({
      value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
    }))
    render(<BillingSection scope={stub.scope} ctx={ctx} t={t} />)

    expect(await screen.findByText('BAI')).toBeDefined()
    expect(screen.getByText('DeepSeek account balance')).toBeDefined()
    expect(screen.getByText('¥12.75')).toBeDefined()
    // A closed card summarises what it holds: two models, one of them priced.
    expect(screen.getByText('2 models')).toBeDefined()
    expect(screen.getByText('1 priced')).toBeDefined()
    expect(screen.queryByLabelText('bai/glm-5.3-flash Cache hit')).toBeNull()

    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    const saved = screen.getByLabelText('bai/glm-5.3-flash Cache hit') as HTMLInputElement
    expect(saved.value).toBe('0.15')
    const blank = screen.getByLabelText('bai/qwen3.8-flash Cache hit') as HTMLInputElement
    expect(blank.value).toBe('')
    // The control reads as its opposite state while the card is open.
    fireEvent.click(screen.getByLabelText('Collapse rates for bai'))
    expect(screen.queryByLabelText('bai/glm-5.3-flash Cache hit')).toBeNull()
  })

  it('queues one path-addressed write per edited field', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const ctx = contextDouble(remoteDouble(), baiDirectory())
    render(<BillingSection scope={stub.scope} ctx={ctx} t={t} />)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))

    const hit = screen.getByLabelText('bai/glm-5.3-flash Cache hit')
    fireEvent.change(hit, { target: { value: '0.15' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Cache miss'), { target: { value: '4.5' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Output'), { target: { value: '13.5' } })
    fireEvent.click(screen.getAllByText('Save')[0] as HTMLElement)
    await act(async () => { await Promise.resolve() })
    expect(stub.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'cacheHit'], value: 0.15 },
      { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'cacheMiss'], value: 4.5 },
      { op: 'set', path: ['models', 'bai/glm-5.3-flash', 'output'], value: 13.5 },
    ])
    expect(screen.getByText('Saved')).toBeDefined()
  })

  it('clears a stored row and reports a refused write', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'bai/glm-5.3-flash': FLASH_RATES }, cache: null, cacheError: null },
    }))
    const ctx = contextDouble(remoteDouble(), baiDirectory({ value: { providers: { bai: { models: [] } } } }))
    render(<BillingSection scope={stub.scope} ctx={ctx} t={t} />)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    fireEvent.click(screen.getByText('Clear'))
    await act(async () => { await Promise.resolve() })
    expect(stub.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['models', 'bai/glm-5.3-flash'] }])

    stub.mutate.mockRejectedValueOnce(new Error('read-only'))
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Save failed: read-only')).toBeDefined()
  })

  it('adds a route by hand and validates its form', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    render(<BillingSection scope={stub.scope} ctx={contextDouble(remoteDouble(), describeFace)} t={t} />)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')

    // The page's own entry point opens the provider it names, so a route no
    // directory declares is still priceable.
    const field = screen.getByLabelText('Add a route manually')
    fireEvent.change(field, { target: { value: 'bai' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByText('Enter provider/model, for example bai/glm-5.3-flash')).toBeDefined()

    fireEvent.change(field, { target: { value: 'custom/model' } })
    fireEvent.click(screen.getByText('Add'))
    expect(screen.getByLabelText('custom/model Cache hit')).toBeDefined()
  })

  it('disables editing on a read-only document and reports a failed balance read', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      writable: false,
      value: { currency: 'USD', models: {}, cache: null, cacheError: 'balance request failed: HTTP 401' },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    render(<BillingSection scope={stub.scope} ctx={contextDouble(remoteDouble(), describeFace)} t={t} />)
    await screen.findByText('This deployment stores settings read-only, so rates cannot be saved.')
    expect(screen.getByText('Balance read failed: balance request failed: HTTP 401')).toBeDefined()
    expect(screen.getByText('Not read')).toBeDefined()
  })

  it('reloads the provider directory when the adapter roster changes', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const ctx = new Context()
    const remote = new TestRemote(ctx, remoteDouble())
    ctx.provide('settingsScope', { describe: () => describeFace } as never)
    render(<BillingSection scope={stub.scope} ctx={ctx} t={t} />)
    await screen.findByText('No configured provider was found. Add a provider and its models on the Models page first.')
    // Both invalidation channels the page follows converge on the same reload.
    await act(async () => { remote.emit('llm/adapters-updated', []) })
    await act(async () => { ctx.emit('connection/reset') })
    expect(screen.getByText('BAI')).toBeDefined()
  })
})

describe('plugin registration', () => {
  it('registers all three surfaces and fiber disposal removes them', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new TestRemote(ctx, {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [] }),
        listConfigurableProviders: () => Promise.resolve({ ok: true, value: [] }),
      },
    })
    ctx.provide('settingsScope', {
      bind: () => stubSettingsScope<BillingSettings>().scope,
      describe: () => ({ ensure: () => Promise.resolve(), getSnapshot: () => ({ view: undefined }) }),
    } as never)
    // The owning views' child declarations, stood up by a bench root entry.
    ctx.slots.register({
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
        'conversation.composer.stats': { kind: 'list', scope: 'session' },
        'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('settings.section')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.composer.stats')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(1)
    expect(ctx.slots.entries('settings.section')[0] !== undefined).toBe(true)
    expect(resolveSlotLabel(ctx.slots.entries('settings.section')[0]?.options.label)).toBe('Billing')

    const select = ctx.slots.entries('conversation.chat.turnTail')[0]?.select
    expect(select?.({ turn: { turn: 4 }, seq: 1, openFile: () => {} } as never)).toEqual({ turn: 4 })

    await fiber.dispose()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.composer.stats')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
  })
})

describe('shared helpers', () => {
  it('aggregates accumulated stretches per route', () => {
    const buckets = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
    expect(groupSteps([
      { route: 'a/b', buckets },
      { route: 'a/b', buckets },
      { route: 'x/y', buckets },
    ], { 'a/b': FLASH_RATES })).toEqual([
      { route: 'a/b', tokens: 2_000_000, cost: 9, priced: true },
      { route: 'x/y', tokens: 1_000_000, cost: 0, priced: false },
    ])
  })

  it('formats relative freshness through the dictionary', () => {
    expect(freshness(Date.now(), t)).toBe('just now')
    expect(freshness(Date.now() - 3 * 86_400_000, t)).toBe('3 d ago')
  })

  it('exposes one bound scope per namespace key', () => {
    const stub: StubSettingsScope<BillingSettings> = stubSettingsScope<BillingSettings>()
    expect(stub.scope.getSnapshot().status).toBe('loading')
    expect(NS).toBe('ui-billing')
  })
})
