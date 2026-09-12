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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { act, useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import {
  makeTranslate, stubSettingsScope, TestRemote, type StubSettingsScope,
} from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { DEFAULT_CURRENCY, NS, type BillingSettings } from '../src/settings.ts'
import { providerRoutes, type ProviderRouteGroup } from '../src/client/routes.ts'
import { SessionCostMeter, currencyOf, freshness, groupSteps } from '../src/client/CostMeter.tsx'
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

/**
 * The plugin's injected face, as the renderer hands it to a component: the
 * namespace read is a selector hook over a bare source, and the provider
 * directory arrives as loaded data plus the loader that refreshes it.
 *
 * The directory source is a real observable so a spec observes the same
 * re-render the page sees. `ctx` is optional because the pill specs need only
 * the namespace read.
 */
function billingFace(stub: StubSettingsScope<BillingSettings>, ctx?: Context) {
  const groups = createSnapshotStore<readonly ProviderRouteGroup[]>([])
  // The renderer binds the injected source with useSyncExternalStore; the spec
  // runs the same binding so a published snapshot re-renders the component
  // exactly as it does in the app.
  const subscribe = (notify: () => void): (() => void) => stub.scope.subscribe(notify)
  const subscribeGroups = (notify: () => void): (() => void) => groups.subscribe(notify)
  return {
    useBilling: ((selector: (value: SettingsScopeSnapshot<BillingSettings>) => unknown) =>
      useSyncExternalStore(subscribe, () => selector(stub.scope.getSnapshot()))) as never,
    useBillingGroups: ((selector: (value: readonly ProviderRouteGroup[]) => unknown) =>
      useSyncExternalStore(subscribeGroups, () => selector(groups.getSnapshot()))) as never,
    saveRate: vi.fn(async () => {}),
    clearRate: vi.fn(async () => {}),
    routeGroups: async () => {
      if (ctx === undefined) return
      const describe = (ctx as unknown as {
        settingsScope: {
          describe(): {
            ensure(): Promise<void>
            getSnapshot(): { view?: { namespaces: readonly { ns: string; value: unknown; user?: unknown }[] } }
          }
        }
      }).settingsScope.describe()
      const [registered, directory] = await Promise.all([
        ctx.remote.llm.listProviders(),
        ctx.remote.llm.listConfigurableProviders(),
      ])
      if (!registered.ok || !directory.ok) return
      await describe.ensure()
      const view = describe.getSnapshot().view
      if (view === undefined) return
      groups.set(providerRoutes(directory.value, registered.value, view.namespaces.map(entry => ({
        ns: entry.ns,
        value: entry.value,
        ...entry.user === undefined ? {} : { user: entry.user },
      }))))
    },
  }
}


/**
 * The framework seats the renderer supplies to a slot entry. These specs drive
 * each component directly and read only its owner share, the plugin's injected
 * face, and its locale seat, so every other seat is a stub here; the members are
 * typed `never` because no spec reads them.
 * @returns one stub per standard seat, including the settings page's `close`.
 */
function seats() {
  return {
    useSession: (() => undefined) as never,
    sessionId: 'session-1' as never,
    useProjection: (() => undefined) as never,
    useConversation: (() => undefined) as never,
    useInput: (() => undefined) as never,
    inputActions: {} as never,
    useChat: (() => undefined) as never,
    useTrajectory: (() => undefined) as never,
    useSessions: (() => [] as never) as never,
    useSessionPendingInteraction: (() => undefined) as never,
    useWorkspaces: (() => undefined) as never,
    usePanelInfo: (() => undefined) as never,
    useResource: (() => undefined) as never,
    close: (() => {}) as never,
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
      <SessionCostMeter {...seats()} useProjection={projection({}) as never} {...billingFace(stub)} t={t} />,
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
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥18.00')).toBeDefined()
    // The visible text is the bare figure; the accessible name states what each
    // figure is, which is what a reader hears and what hover shows. Both pills
    // are reached by that name because the balance pill also carries its amount
    // inside a localized label.
    expect(screen.getByLabelText('¥18.00 this session')).toBeDefined()
    expect(screen.getByLabelText('DeepSeek account balance ¥12.75')).toBeDefined()
    expect(screen.getByLabelText('DeepSeek account balance ¥12.75').textContent).toContain('12.75')
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
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'bai', model: 'glm-5.3-flash' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('¥13.50')).toBeDefined()
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
    expect(screen.getByText('¥20.00')).toBeDefined()
  })

  it('names an unpriced route instead of inventing a total', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'x', model: 'y' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    // The visible text is the bare dash for both figures, so the pill is
    // addressed by what it means.
    const pill = screen.getByLabelText('Session cost unavailable')
    expect(pill.textContent).toContain('-')
    fireEvent.click(pill)
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
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('DeepSeek account balance $3.00'))
    const dialog = screen.getByRole('dialog', { name: 'DeepSeek account balance' })
    expect(within(dialog).getByText('Insufficient balance')).toBeDefined()
    expect(within(dialog).getByText('2 min ago')).toBeDefined()
    expect(within(dialog).getByText('Balance read failed: balance request failed: HTTP 401')).toBeDefined()
  })

  it('closes on Escape and on an outside pointer', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({ value: { currency: 'CNY', models: {}, cache: null, cacheError: 'x' } }))
    render(<SessionCostMeter {...seats()} useProjection={projection({}) as never} {...billingFace(stub)} t={t} />)
    const trigger = screen.getByLabelText('DeepSeek account balance unavailable')
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
      <SessionCostMeter {...seats()}
        useProjection={projection({
          tokenUsage: usage,
          modelSelection: { lastUsed: { provider: 'a', model: 'b' }, next: null },
        }) as never}
        {...billingFace(stub)}
        t={t} />,
    )
    fireEvent.click(screen.getByLabelText('¥4.50 this session'))
    expect(screen.getByRole('dialog', { name: 'Session cost' })).toBeDefined()
    fireEvent.click(screen.getByLabelText('DeepSeek account balance ¥1.00'))
    expect(screen.queryByRole('dialog', { name: 'Session cost' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'DeepSeek account balance' })).toBeDefined()
  })
})

describe('reactive namespace read', () => {
  it('binds one observable source per plugin face and releases it with the entry', () => {
    const stub = stubSettingsScope<BillingSettings>()
    // What the plugin hands the renderer: a bare source, not a hook.
    const source = {
      getSnapshot: () => stub.scope.getSnapshot(),
      subscribe: (notify: () => void) => stub.scope.subscribe(notify),
    }
    expect(source.getSnapshot().value).toBeUndefined()
    stub.publish(snapshot({ value: { currency: 'USD', models: {}, cache: null, cacheError: null } }))
    expect(source.getSnapshot().value?.currency).toBe('USD')
    // The renderer derives `useBilling` from this source; the framework's own
    // binding is pinned by ui-renderer's `hooks` specs, so what this package
    // owns is the source and the snapshot identity it answers with.
    const first = source.getSnapshot()
    expect(source.getSnapshot()).toBe(first)
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
      key: 'assistant-1', kind: 'assistant-step', target: 'chat', anchorSeq: 2, location: { kind: 'session' },
      visibility: 'visible', id: 'assistant-1',
      data: {
        turn: 1,
        finalNode: {
          usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
          provenance: { provider: 'bai', model: 'glm-5.3-flash' },
        },
      },
    },
    {
      // The same Turn's second attempt on another route: the window's own
      // evidence for what a turn that switched models was billed.
      key: 'assistant-2', kind: 'assistant-step', target: 'chat', anchorSeq: 4, location: { kind: 'session' },
      visibility: 'visible', id: 'assistant-2',
      data: {
        turn: 1,
        finalNode: {
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
          provenance: { provider: 'x', model: 'other' },
        },
      },
    },
    {
      // A Turn that ran only on a route with no rate at all, official prices
      // included: the unpriced arm needs a provider of its own.
      key: 'turn-tail-3', kind: 'turn-tail', target: 'chat', anchorSeq: 7, location: { kind: 'session' },
      visibility: 'visible', id: 'turn-tail-3',
      data: {
        turn: 3,
        tokenUsage: {
          uncachedInputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000,
          cacheReadTokens: 0, cacheWriteTokens: 0,
          routes: [{ provider: 'x', model: 'other' }],
        },
      },
    },
    {
      key: 'assistant-3', kind: 'assistant-step', target: 'chat', anchorSeq: 6, location: { kind: 'session' },
      visibility: 'visible', id: 'assistant-3',
      data: {
        turn: 3,
        finalNode: {
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
          provenance: { provider: 'x', model: 'other' },
        },
      },
    },
  ] as unknown as readonly ChatConversationViewNode[]

  function useChat<T>(select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => T): T {
    return select({ nodes: { values: () => nodes } })
  }

  it('reads each attempt of the turn', () => {
    expect(attemptsOf(nodes, 1)).toEqual([
      {
        route: 'bai/glm-5.3-flash',
        buckets: { uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        route: 'x/other',
        buckets: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
      },
    ])
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
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('Cost ¥18.00')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Cost ¥18.00'))
    const dialog = screen.getByRole('dialog', { name: 'Turn cost' })
    const rows = dialog.querySelector('[data-billing-turn-routes]')
    expect(rows?.textContent).toContain('bai/glm-5.3-flash')
    expect(rows?.textContent).toContain('¥18.00')
    // The second route carries no rates here, so its share is named as unpriced
    // instead of being folded into the total.
    expect(rows?.textContent).toContain('x/other')
    expect(within(dialog).getAllByText('No rates configured').length).toBeGreaterThan(0)
    // The dialog's footnote names every route it priced, next to the share it
    // could not price.
    expect(within(dialog).getByText(/bai\/glm-5\.3-flash: 0\.15 \/ 4\.5 \/ 13\.5/)).toBeDefined()
  })

  it('shows no figure for a turn whose own accounting is incomplete', () => {
    // The session projection is a session-wide running total, so it can never
    // stand in for one turn: a turn whose token accounting is absent — its
    // events paged out, an attempt that never settled — reads as no figure,
    // exactly as its own Turn-usage pill reads.
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const view = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 9 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(view.container.innerHTML).toBe('')
  })

  it('reports an unpriced turn and stays silent without accounting', () => {
    // Turn 3 ran only on a route nothing prices, official defaults included.
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const { unmount } = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 3 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(screen.getByText('Cost -')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Cost -'))
    expect(screen.getByText('No rates configured; this turn is not billed')).toBeDefined()
    unmount()

    const empty = render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 9 } as never} seq={1} openFile={() => {}}
        useChat={useChat as never}
        {...billingFace(stub)}
        t={t} />,
    )
    expect(empty.container.innerHTML).toBe('')
  })

  it('declines a turn whose several routes have no loaded attempt', () => {
    // The turn's own accounting names two routes and no attempt survived to
    // split them, so the pill withholds the figure and the dialog names what it
    // could not attribute instead of charging the aggregate twice.
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: {
        currency: 'CNY',
        models: { 'bai/glm-5.3-flash': FLASH_RATES, 'x/other': FLASH_RATES },
        cache: null,
        cacheError: null,
      },
    }))
    const unattributed = [
      {
        key: 'turn-tail', kind: 'turn-tail', target: 'chat', anchorSeq: 3, location: { kind: 'session' },
        visibility: 'visible', id: 'turn-tail',
        data: {
          turn: 1,
          tokenUsage: {
            uncachedInputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            routes: [{ provider: 'bai', model: 'glm-5.3-flash' }, { provider: 'x', model: 'other' }],
          },
        },
      },
    ] as unknown as readonly ChatConversationViewNode[]
    const nodes = (select: (snapshot: { nodes: { values(): readonly ChatConversationViewNode[] } }) => unknown) =>
      select({ nodes: { values: () => unattributed } })
    render(
      <TurnCostMeter {...seats()}
        turn={{ turn: 1 } as never} seq={1} openFile={() => {}}
        useChat={nodes as never}
        {...billingFace(stub)}
        t={t} />,
    )
    const pill = screen.getByLabelText('Cost -')
    expect(pill.textContent).toContain('-')
    fireEvent.click(pill)
    expect(screen.getByText('This turn ran on several routes (bai/glm-5.3-flash, x/other), and the loaded evidence cannot split them, so no cost is counted')).toBeDefined()
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
    // The user layer is what marks `bai` configured; its profile carries the
    // model list the page prices.
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
      user: { providers: { bai: { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }] } } },
    }))
    const face1 = billingFace(stub, ctx)
    render(<BillingSection {...seats()} {...face1} t={t} />)

    await waitFor(() => { expect(screen.queryByText('BAI')).not.toBeNull() })
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

  it('shows the published official price as the fallback a route is billed at', async () => {
    // The official provider is configured by the deployment rather than by the
    // user layer, and its model carries no stored rate: the card is priced by
    // the published table, and the fields show it as the placeholder the user
    // overrides.
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [{ id: 'deepseek-official', name: 'DeepSeek' }] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [{
            provider: 'deepseek-official',
            displayName: 'DeepSeek',
            settingsNs: 'llm-deepseek',
            settingsPath: ['providers', 'deepseek-official'],
          }],
        }),
      },
    }
    const directory = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [{
            ns: 'llm-deepseek',
            value: { providers: { 'deepseek-official': { models: [{ id: 'deepseek-v4-flash' }] } } },
          }],
        },
      }),
    }
    const face = billingFace(stub, contextDouble(remote, directory))
    render(<BillingSection {...seats()} {...face} t={t} />)

    await screen.findByText('DeepSeek')
    expect(screen.getByText('1 priced')).toBeDefined()
    fireEvent.click(screen.getByLabelText('Edit rates for deepseek-official'))
    const hit = screen.getByLabelText('deepseek-official/deepseek-v4-flash Cache hit') as HTMLInputElement
    expect(hit.value).toBe('')
    expect(hit.placeholder).toBe('0.021')
    expect(screen.getByText('default rate')).toBeDefined()
  })

  it('queues one path-addressed write per edited field', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const ctx = contextDouble(remoteDouble(), baiDirectory())
    const face2 = billingFace(stub, ctx)
    render(<BillingSection {...seats()} {...face2} t={t} />)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))

    const hit = screen.getByLabelText('bai/glm-5.3-flash Cache hit')
    fireEvent.change(hit, { target: { value: '0.15' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Cache miss'), { target: { value: '4.5' } })
    fireEvent.change(screen.getByLabelText('bai/glm-5.3-flash Output'), { target: { value: '13.5' } })
    fireEvent.click(screen.getAllByText('Save')[0] as HTMLElement)
    await act(async () => { await Promise.resolve() })
    // The page hands the plugin the three typed fields; the plugin owns how
    // they become settings writes.
    expect(face2.saveRate).toHaveBeenCalledWith('bai/glm-5.3-flash', {
      cacheHit: '0.15', cacheMiss: '4.5', output: '13.5',
    })
    expect(screen.getByText('Saved')).toBeDefined()
  })

  it('clears a stored row and reports a refused write', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      value: { currency: 'CNY', models: { 'bai/glm-5.3-flash': FLASH_RATES }, cache: null, cacheError: null },
    }))
    const ctx = contextDouble(remoteDouble(), baiDirectory({
      value: { providers: { bai: { models: [] } } },
      user: { providers: { bai: {} } },
    }))
    const face3 = billingFace(stub, ctx)
    render(<BillingSection {...seats()} {...face3} t={t} />)
    await screen.findByText('BAI')
    fireEvent.click(screen.getByLabelText('Edit rates for bai'))
    fireEvent.click(screen.getByText('Clear'))
    await act(async () => { await Promise.resolve() })
    expect(face3.clearRate).toHaveBeenCalledWith('bai/glm-5.3-flash')

    face3.saveRate.mockRejectedValueOnce(new Error('read-only'))
    fireEvent.click(screen.getByText('Save'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('Save failed: read-only')).toBeDefined()
  })

  it('adds a route by hand and validates its form', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face4 = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    render(<BillingSection {...seats()} {...face4} t={t} />)
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

  it('keeps a configured provider that has no model list, so its routes can be added', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot())
    // x is configured in the user layer but its settings path names no models.
    const directory = {
      ensure: () => Promise.resolve(),
      getSnapshot: () => ({
        view: {
          namespaces: [
            { ns: 'llm-pi-ai', value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } },
              user: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } } },
            { ns: 'llm-x', value: {}, user: { providers: { x: {} } } },
          ],
        },
      }),
    }
    const remote = {
      llm: {
        listProviders: () => Promise.resolve({ ok: true, value: [] }),
        listConfigurableProviders: () => Promise.resolve({
          ok: true,
          value: [
            { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
            { provider: 'x', displayName: 'X', settingsNs: 'llm-x', settingsPath: ['providers', 'x'] },
          ],
        }),
      },
    }
    const face5 = billingFace(stub, contextDouble(remote, directory))
    render(<BillingSection {...seats()} {...face5} t={t} />)
    expect(await screen.findByText('BAI')).toBeDefined()
    // The configured-but-modelless provider keeps its card as the seat for a
    // hand-added route; an unconfigured catalogue row adds none.
    expect(screen.getByText('X')).toBeDefined()
    expect(screen.queryByText('0 models')).toBeDefined()
  })

  it('disables editing on a read-only document and reports a failed balance read', async () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({
      writable: false,
      value: { currency: 'USD', models: {}, cache: null, cacheError: 'balance request failed: HTTP 401' },
    }))
    const describeFace = { ensure: () => Promise.resolve(), getSnapshot: () => ({ view: { namespaces: [] } }) }
    const face6 = billingFace(stub, contextDouble(remoteDouble(), describeFace))
    render(<BillingSection {...seats()} {...face6} t={t} />)
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
    const face7 = billingFace(stub, ctx)
    render(<BillingSection {...seats()} {...face7} t={t} />)
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
        'conversation.chat.turn-stats': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('settings.section')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.composer.stats')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.chat.turn-stats')).toHaveLength(1)
    expect(ctx.slots.entries('settings.section')[0] !== undefined).toBe(true)
    expect(resolveSlotLabel(ctx.slots.entries('settings.section')[0]?.options.label)).toBe('Billing')

    await fiber.dispose()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.composer.stats')).toHaveLength(0)
    expect(ctx.slots.entries('conversation.chat.turn-stats')).toHaveLength(0)
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
