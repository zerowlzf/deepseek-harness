// @vitest-environment jsdom
/**
 * The published official prices this package falls back to: they price the
 * official provider's routes until the user stores a row of their own, and they
 * never touch any other provider's route.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen, render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { makeTranslate, stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import type { BillingSettings } from '../src/settings.ts'
import { DEFAULT_CURRENCY } from '../src/settings.ts'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { OFFICIAL_RATES, defaultRateOf, effectiveRates } from '../src/client/official-rates.ts'
import { SessionCostMeter } from '../src/client/CostMeter.tsx'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(en, zh)

afterEach(() => { cleanup() })

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

/** The framework seats the renderer supplies, stubbed as in the component specs. */
function seats() {
  return {
    useSession: (() => undefined) as never,
    sessionId: 'session-1' as never,
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

/** The plugin's injected face over one namespace stub. */
function billingFace(stub: StubSettingsScope<BillingSettings>) {
  return {
    useBilling: ((selector: (value: SettingsScopeSnapshot<BillingSettings>) => unknown) =>
      selector(stub.scope.getSnapshot())) as never,
    useBillingGroups: (() => []) as never,
    saveRate: vi.fn(async () => {}),
    clearRate: vi.fn(async () => {}),
    routeGroups: async () => {},
  }
}

describe('official rate defaults', () => {
  it('prices the official provider’s published routes', () => {
    expect(defaultRateOf('deepseek-official/deepseek-v4-flash')).toEqual({
      cacheHit: 0.021, cacheMiss: 1.07, output: 4.26,
    })
    expect(Object.keys(OFFICIAL_RATES).every(route => route.startsWith('deepseek-official/'))).toBe(true)
  })

  it('lets a stored row override a published price and leaves other providers alone', () => {
    const rates = effectiveRates({ 'deepseek-official/deepseek-v4-flash': { cacheHit: 9, cacheMiss: 9, output: 9 } })
    expect(rates['deepseek-official/deepseek-v4-flash']).toEqual({ cacheHit: 9, cacheMiss: 9, output: 9 })
    expect(rates['deepseek-official/deepseek-v4-pro']).toEqual(defaultRateOf('deepseek-official/deepseek-v4-pro'))
    expect(rates['bai/glm-5.3-flash']).toBeUndefined()
    expect(defaultRateOf('bai/glm-5.3-flash')).toBeUndefined()
  })

  it('prices a session on an official route the document never priced', () => {
    const stub = stubSettingsScope<BillingSettings>()
    stub.publish(snapshot({ value: { currency: 'CNY', models: {}, cache: null, cacheError: null } }))
    const usage: TokenUsageProjection = {
      uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    render(
      <SessionCostMeter {...seats()}
        useProjection={((key: string) => key === 'tokenUsage'
          ? usage
          : { lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, next: null })}
        {...billingFace(stub)}
        t={t} />,
    )
    // 1M uncached input at the published 1.07 per million.
    expect(screen.getByText('¥1.07')).toBeDefined()
    fireEvent.click(screen.getByLabelText('¥1.07 this session'))
    expect(screen.getByText('deepseek-official/deepseek-v4-flash')).toBeDefined()
  })
})
