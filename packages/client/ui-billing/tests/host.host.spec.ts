/**
 * ui-billing Host half: the namespace registration and the balance refresh
 * chain. The settings provider is a real in-memory subclass of the seam and the
 * credential store is the credentials package's own in-memory provider, so what
 * is asserted here is this package's own contract — the namespace it registers
 * under, what a settled read writes back, that a failed read keeps the previous
 * snapshot, that activation waits for the store, and that disposal stops the
 * chain.
 */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { DEFAULT_BASE_URL, readBalance } from '../src/account.ts'
import { Config } from '../src/index.ts'
import { apply, inject } from '../src/index.ts'
import { DEFAULT_CURRENCY, NS } from '../src/settings.ts'

/**
 * In-memory settings provider: the smallest real subclass of the Service
 * Definition, standing in for the file-backed provider a deployment mounts.
 */
class MemorySettings extends SettingsProvider {
  /** Raw document the provider's storage currently holds. */
  doc: Record<string, unknown>
  /** Every persist() call observed, in order. */
  readonly persisted: Array<{ ns: SettingsNamespace; section: Record<string, unknown> }> = []
  private readonly writableFlag: boolean

  constructor(
    ctx: ConstructorParameters<typeof SettingsProvider>[0],
    options: { doc?: Record<string, unknown>; writable?: boolean } = {},
  ) {
    super(ctx)
    this.doc = structuredClone(options.doc ?? {})
    this.writableFlag = options.writable ?? true
  }

  get writable(): boolean {
    return this.writableFlag
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.persisted.push({ ns, section: structuredClone(section) })
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()?.()
})

/** Resolve one cached read out of the provider's stored document. */
function storedCache(settings: MemorySettings): unknown {
  const section = settings.doc[NS] as Record<string, unknown> | undefined
  return section?.['cache']
}

/** Values the Loader resolves from the plugin's own `Config` schema. */
const RESOLVED_CONFIG = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: DEFAULT_BASE_URL,
  currency: DEFAULT_CURRENCY,
  refreshIntervalMs: 0,
  requestTimeoutMs: 15_000,
} satisfies Config

/**
 * Mount the Host half over the in-memory provider.
 * @param config - plugin configuration overrides.
 * @returns the context, the provider holding the writes, and the plugin fiber.
 */
async function mount(config: Partial<Config> = {}): Promise<{
  ctx: Context
  settings: MemorySettings
  fiber: { dispose: () => Promise<void> }
}> {
  const ctx = new Context()
  // The real timer service mixes `timeout` onto the context, which is the API
  // the plugin's refresh chain re-arms through.
  await ctx.plugin(Timer)
  const settings = new MemorySettings(ctx)
  new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
  const fiber = ctx.plugin({ inject, apply }, { ...RESOLVED_CONFIG, ...config })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return { ctx, settings, fiber }
}

describe('configuration', () => {
  it('defaults every key the plugin reads', () => {
    // The empty object is what a deployment that sets nothing resolves from;
    // the schema fills every key, which is the fact under test.
    const resolved = new Schema(Config)({} as never)
    expect(resolved).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: DEFAULT_BASE_URL,
      currency: DEFAULT_CURRENCY,
      refreshIntervalMs: 300_000,
      requestTimeoutMs: 15_000,
    })
  })
})

describe('namespace ownership', () => {
  const balanceBody = {
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
  }

  it('registers the ui-billing namespace and caches the read', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(balanceBody)))
    vi.stubGlobal('fetch', fetchImpl)
    const { ctx, settings } = await mount()

    expect(ctx.settings.describe({ redactSecrets: true }).map(view => view.ns)).toContain(NS)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${DEFAULT_BASE_URL}/user/balance`)
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer key-under-test')
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34, currency: 'CNY' }) })
    expect(settings.doc[NS]).toMatchObject({ cacheError: null })
  })

  it('waits for the credential store before its first read', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(balanceBody)))
    vi.stubGlobal('fetch', fetchImpl)
    const ctx = new Context()
    await ctx.plugin(Timer)
    const settings = new MemorySettings(ctx)
    const fiber = ctx.plugin({ inject, apply }, RESOLVED_CONFIG)
    cleanups.push(async () => { await fiber.dispose() })
    // The mount is pending on the missing service, so no read has run yet.
    expect(fetchImpl).not.toHaveBeenCalled()
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(storedCache(settings)).toMatchObject({ total: 12.34 }) })
  })

  it('records the reason and keeps the previous snapshot when a read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 401 }))))
    const { settings } = await mount()
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ cacheError: 'balance request failed: HTTP 401' })
    })
    expect(settings.doc[NS]).not.toHaveProperty('cache')
  })

  it('keeps a previously read balance across a failed refresh', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(balanceBody)))
    vi.stubGlobal('fetch', fetchImpl)
    const { settings } = await mount({ refreshIntervalMs: 500 })
    await vi.waitFor(() => { expect(storedCache(settings)).not.toBeUndefined() })

    // The next tick fails; the settled amount stays and the reason is recorded.
    fetchImpl.mockImplementation(() => Promise.reject(new Error('offline')))
    await vi.advanceTimersByTimeAsync(500)
    await vi.waitFor(() => {
      expect(settings.doc[NS]).toMatchObject({ cacheError: 'balance request failed: offline' })
    })
    expect(storedCache(settings)).toMatchObject({ total: 12.34 })
    vi.useRealTimers()
  })

  it('re-arms the refresh chain after each settlement when an interval is configured', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json(balanceBody))))
    const ctx = new Context()
    await ctx.plugin(Timer)
    new MemorySettings(ctx)
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    // The chain arms through the timer service's own `timeout`, whose
    // fiber-owned effect belongs to that service.
    const timeout = vi.spyOn(ctx.timer, 'timeout')
    // The spy answers whichever overload was called; the callback form is the
    // one this chain arms, so the callback-and-delay pair is what is asserted.
    const fiber = ctx.plugin({ inject, apply }, { ...RESOLVED_CONFIG, refreshIntervalMs: 1_000 })
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    await vi.waitFor(() => { expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000) })
  })

  it('stops the chain on disposal', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(balanceBody)))
    vi.stubGlobal('fetch', fetchImpl)
    const { settings, fiber } = await mount()
    await vi.waitFor(() => { expect(storedCache(settings)).not.toBeUndefined() })
    await fiber.dispose()
    const calls = fetchImpl.mock.calls.length
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(fetchImpl.mock.calls).toHaveLength(calls)
  })

  it('keeps a refused write from breaking the chain', async () => {
    const warn = vi.fn()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json(balanceBody))))
    const ctx = new Context()
    await ctx.plugin(Timer)
    const readOnly = new MemorySettings(ctx, { writable: false })
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    ctx.logger.warn = warn as never
    const fiber = ctx.plugin({ inject, apply }, RESOLVED_CONFIG)
    cleanups.push(async () => { await fiber.dispose() })
    await fiber
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(warn.mock.calls[0]?.[0]).toBe('ui-billing: balance cache write failed')
    expect(readOnly.persisted).toEqual([])
  })
})

describe('readBalance', () => {
  const request = {
    baseURL: `${DEFAULT_BASE_URL}/`, apiKeyEnv: 'BILLING_TEST_KEY', currency: 'CNY', timeoutMs: 1_000,
  }

  it('reports a missing credential without a request', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const result = await readBalance(new Context(), request)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error).toContain('BILLING_TEST_KEY')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('prefers the configured currency and reports availability', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      is_available: false,
      balance_infos: [
        { currency: 'USD', total_balance: '1.5' },
        { currency: 'CNY', total_balance: '10.25' },
      ],
    }))))
    const result = await readBalance(new Context(), request)
    expect(result.ok).toBe(true)
    expect(result.ok ? result.balance : undefined).toMatchObject({
      total: 10.25, currency: 'CNY', available: false,
    })
  })

  it('falls back to the first reported currency', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({
      balance_infos: [{ currency: 'USD', total_balance: '2' }],
    }))))
    const result = await readBalance(new Context(), request)
    expect(result.ok ? result.balance.currency : undefined).toBe('USD')
  })

  it('refuses each malformed response', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    for (const [body, expected] of [
      ['not json', 'was not JSON'],
      ['"scalar"', 'was not an object'],
      ['{}', 'no balance_infos array'],
      ['{"balance_infos":[]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"CNY"}]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"","total_balance":"1"}]}', 'no usable amount'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))))
      const result = await readBalance(new Context(), request)
      expect(result.ok, body).toBe(false)
      expect(result.ok ? '' : result.error, body).toContain(expected)
    }
  })

  it('reports a transport failure', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('socket closed'))))
    const result = await readBalance(new Context(), request)
    expect(result.ok ? '' : result.error).toBe('balance request failed: socket closed')
  })

  it('reports a non-Error rejection verbatim', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))))
    const result = await readBalance(new Context(), request)
    expect(result.ok ? '' : result.error).toBe('balance request failed: boom')
  })
})
