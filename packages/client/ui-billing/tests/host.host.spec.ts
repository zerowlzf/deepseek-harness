/**
 * ui-billing Host half: the profile entry and the two refresh chains. The
 * composition is real — the Loader boots a throwaway profile whose patch
 * carries the config-editor, settings, and ui-billing entries, the settings
 * service edits the live configuration through the profile patch, and the
 * timer and credential services are the real ones — so only the two provider
 * endpoints are stubbed. What is asserted here is this package's own
 * contract: the namespace its entry describes, what a settled read writes
 * back, that a failed read keeps the previous value, that activation waits
 * for the credential store, and that disposal stops the chains.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, readBalance } from '../src/account.ts'
import { Config, apply, inject } from '../src/index.ts'
import { DEFAULT_PRICING_URL } from '../src/published-prices.ts'
import { DEFAULT_CURRENCY, NS, type BillingSettings } from '../src/settings.ts'
import { PRICING_EN_HTML, PRICING_ZH_HTML } from './price-page-fixture.ts'

/** The Host plugin as one Loader builtin, under the name its profile entries import it by. */
const BillingPlugin = { Config, inject, apply }

/** Entry configuration every boot starts from: both chains read once and schedule nothing. */
const RUN_CONFIG = { refreshIntervalMs: 0, pricingRefreshIntervalMs: 0 }

/** Key resolution as the plugin performs it, over the environment alone here. */
const fromEnv = (): Promise<string | undefined> => Promise.resolve(process.env['BILLING_TEST_KEY'])

/** The balance the stubbed account endpoint answers with. */
const BALANCE_BODY = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' }],
}

/** One published page answer, defaulting to the table the recorded live page serves. */
function pageResponse(options: { content?: string; statusCode?: number } = {}): Response {
  return new Response(options.content ?? PRICING_ZH_HTML, { status: options.statusCode ?? 200 })
}

/** What one test's two reads answer; each defaults to a successful answer. */
interface Answers {
  /** Account endpoint answer; defaults to a funded account. */
  balance?: () => Promise<Response>
  /** Published page answer; defaults to the recorded Chinese table. */
  prices?: () => Promise<Response>
}

/**
 * Answer both Host reads, each through the process's own `fetch`: the account
 * endpoint and the published page are both plain HTTP GETs now, so one stub
 * serves the two of them and rejects any other request.
 * @param answers - per-read overrides.
 * @returns the stub, so a test can assert what each read was asked for.
 */
function stubReads(answers: Answers = {}) {
  const fetchImpl = vi.fn((url: string, _init?: RequestInit): Promise<Response> => {
    if (url === DEFAULT_PRICING_URL) return answers.prices?.() ?? Promise.resolve(pageResponse())
    if (url === `${DEFAULT_BASE_URL}/user/balance`) return answers.balance?.() ?? Promise.resolve(Response.json(BALANCE_BODY))
    return Promise.reject(new Error(`unexpected request: ${url}`))
  })
  vi.stubGlobal('fetch', fetchImpl)
  return { fetchImpl }
}

/** The stubbed `fetch`, recording every request both reads made. */
type FetchStub = ReturnType<typeof stubReads>['fetchImpl']

/** The reads one endpoint has answered, by the URL they went to. */
function callsTo(fetchImpl: FetchStub, url: string) {
  return fetchImpl.mock.calls.filter(call => call[0] === url)
}

/** The billing entry's fiber, which stays pending until its services arrive. */
function billingFiber(ctx: Context): Fiber {
  const entry = ctx.configEditor.entries().find(row => row.options.id === NS)
  if (entry === undefined || entry.fiber === undefined) throw new Error('the ui-billing entry did not load')
  return entry.fiber
}

/** The billing namespace as the settings domain currently projects it, or undefined once the entry stopped. */
function billingRow(ctx: Context) {
  return ctx.settings.describe().find(row => row.ns === NS)
}

/** The billing namespace's live value. */
function billingValue(ctx: Context): BillingSettings {
  const row = billingRow(ctx)
  if (row === undefined) throw new Error('the ui-billing namespace is not described')
  return row.value as BillingSettings
}

/**
 * Boot a throwaway profile carrying the real config-editor, settings, and
 * ui-billing entries, with the timer service already mounted. The billing
 * fiber stays pending until the test mounts a credential store, which is the
 * seam the plugin's own activation waits on.
 * @param config - the billing entry's configuration, over the read-once defaults.
 * @returns the booted context and the billing entry's fiber.
 */
async function bootBilling(config: Record<string, unknown> = {}): Promise<{ ctx: Context; fiber: Fiber }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ui-billing-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: NS, name: 'cordis:billing', config: { ...RUN_CONFIG, ...config } },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('profileContext', profile)
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(ctx.loader.builtins, { editor: ConfigEditor, settings: Settings, billing: BillingPlugin })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  return { ctx, fiber: billingFiber(ctx) }
}

/**
 * Boot the real composition with both endpoints stubbed and the credential
 * store mounted, and wait for the plugin to activate.
 * @param options - entry configuration overrides, per-read answers, and the credential store's seed.
 * @returns the booted context, the read stub, and the billing fiber.
 */
async function mount(options: {
  config?: Record<string, unknown>
  answers?: Answers
  credentials?: Record<string, string>
} = {}): Promise<{ ctx: Context; fiber: Fiber; fetchImpl: FetchStub }> {
  const { fetchImpl } = stubReads(options.answers)
  const booted = await bootBilling(options.config)
  new MemoryCredentials(booted.ctx, options.credentials ?? { DEEPSEEK_API_KEY: 'key-under-test' })
  await booted.fiber
  return { ...booted, fetchImpl }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('configuration', () => {
  it('defaults every key the plugin reads', () => {
    // The empty object is what a deployment that sets nothing resolves from;
    // the schema fills every key. The live fields resolve as references the
    // settings domain edits through, so each is asserted through its `get`.
    const resolved = Config({} as never)
    expect(resolved.apiKeyEnv).toBe(DEFAULT_API_KEY_ENV)
    expect(resolved.baseURL).toBe(DEFAULT_BASE_URL)
    expect(resolved.refreshIntervalMs).toBe(300_000)
    expect(resolved.pricingUrl).toBe(DEFAULT_PRICING_URL)
    expect(resolved.pricingRefreshIntervalMs).toBe(15 * 86_400_000)
    expect(resolved.requestTimeoutMs).toBe(15_000)
    expect(resolved.currency.get()).toBe(DEFAULT_CURRENCY)
    expect(resolved.models.get()).toEqual({})
    // A state field the document has not written is an absent key: the
    // reference reads `undefined`, and every consumer reads that absence as
    // `null` through the plugin's own snapshot.
    expect(resolved.cache.get()).toBeUndefined()
    expect(resolved.cacheError.get()).toBeUndefined()
    expect(resolved.official.get()).toBeUndefined()
    expect(resolved.officialError.get()).toBeUndefined()
    expect(resolved.officialRequest.get()).toBeUndefined()
  })

  it('still validates a failure persisted before the native-fetch port', () => {
    // No read produces the no-web arm any more; a document written when the
    // page went through a mountable web capability still carries it, and the
    // schema must keep accepting what it once wrote.
    const resolved = Config({ officialError: { kind: 'noWeb' } } as never)
    expect(resolved.officialError.get()).toEqual({ kind: 'noWeb' })
  })
})

describe('namespace ownership', () => {
  it('describes the ui-billing namespace and caches both reads', async () => {
    const { ctx, fetchImpl } = await mount()

    // The entry is the namespace, and the plugin keeps the generated form out
    // of the Plugins page: the Billing page is the one surface that writes it.
    await vi.waitFor(() => {
      expect(billingRow(ctx)).toMatchObject({ ns: NS, autoGenerate: false })
      expect(billingValue(ctx).cache).toMatchObject({ total: 12.34, currency: 'CNY' })
      expect(billingValue(ctx).official).toMatchObject({
        currency: 'CNY',
        source: DEFAULT_PRICING_URL,
        models: {
          'deepseek-flash': {
            cacheHit: 0.04, cacheMiss: 2, output: 8,
            offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
          },
        },
      })
    })
    expect(billingValue(ctx)).toMatchObject({ cacheError: null, officialError: null })
    // The balance is this package's own request, on the key the store held.
    const balances = callsTo(fetchImpl, `${DEFAULT_BASE_URL}/user/balance`)
    expect(balances).toHaveLength(1)
    expect((balances[0]?.[1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer key-under-test' })
    // The published page is read through the same `fetch`, as text.
    expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1)
  })

  it('waits for the credential store before its first read', async () => {
    const { fetchImpl } = stubReads()
    const { ctx, fiber } = await bootBilling()
    // The plugin is pending on the missing service, so no read has run yet.
    expect(fetchImpl).not.toHaveBeenCalled()
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(billingValue(ctx).cache).toMatchObject({ total: 12.34 }) })
  })

  it('records the reason and keeps the previous snapshot when a read fails', async () => {
    const { ctx } = await mount({ answers: { balance: () => Promise.resolve(new Response('nope', { status: 401 })) } })
    await vi.waitFor(() => {
      expect(billingValue(ctx).cacheError).toEqual({ kind: 'http', status: 401 })
    })
    // No read ever wrote a balance, so the document omits the field; a
    // consumer reads that absence as `null` through the plugin's snapshot.
    expect(billingValue(ctx).cache).toBeUndefined()
  })

  it('records why a price read produced no table and keeps the routes on the shipped snapshot', async () => {
    const { ctx } = await mount({ answers: { prices: () => Promise.resolve(pageResponse({ statusCode: 500 })) } })
    await vi.waitFor(() => {
      expect(billingValue(ctx).officialError).toEqual({ kind: 'http', status: 500 })
    })
    // No table was ever read, so the field is absent rather than null.
    expect(billingValue(ctx).official).toBeUndefined()
  })

  it('refuses a price page stated in another currency', async () => {
    const { ctx } = await mount({ answers: { prices: () => Promise.resolve(pageResponse({ content: PRICING_EN_HTML })) } })
    await vi.waitFor(() => {
      expect(billingValue(ctx).officialError).toEqual({ kind: 'currency', found: 'USD', expected: 'CNY' })
    })
    // No table was ever read, so the field is absent rather than null.
    expect(billingValue(ctx).official).toBeUndefined()
  })

  it('keeps a previously read balance across a failed refresh', async () => {
    const { ctx, fetchImpl } = await mount({ config: { refreshIntervalMs: 200 } })
    await vi.waitFor(() => { expect(billingValue(ctx).cache).toMatchObject({ total: 12.34 }) })

    // The next tick fails; the settled amount stays and the reason is recorded.
    fetchImpl.mockImplementation(() => Promise.reject(new Error('offline')))
    await vi.waitFor(() => {
      expect(billingValue(ctx).cacheError).toEqual({ kind: 'network', detail: 'offline' })
    })
    expect(billingValue(ctx).cache).toMatchObject({ total: 12.34 })
  })

  it('re-arms the refresh chain after each settlement when an interval is configured', async () => {
    stubReads()
    const { ctx, fiber } = await bootBilling({ refreshIntervalMs: 1_000 })
    // The chain arms through the timer service's own `timeout`, whose
    // fiber-owned effect belongs to that service.
    const timeout = vi.spyOn(ctx.timer, 'timeout')
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(timeout).toHaveBeenCalledWith(expect.any(Function), 1_000) })
  })

  it('re-arms the price chain on its own interval', async () => {
    stubReads()
    const { ctx, fiber } = await bootBilling({ pricingRefreshIntervalMs: 86_400_000 })
    const timeout = vi.spyOn(ctx.timer, 'timeout')
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(timeout).toHaveBeenCalledWith(expect.any(Function), 86_400_000) })
  })

  it('stops the chains on disposal', async () => {
    const { ctx, fetchImpl, fiber } = await mount({ config: { refreshIntervalMs: 500, pricingRefreshIntervalMs: 500 } })
    const balanceUrl = `${DEFAULT_BASE_URL}/user/balance`
    await vi.waitFor(() => {
      expect(callsTo(fetchImpl, balanceUrl)).toHaveLength(1)
      expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1)
      // Both reads have settled into the document too: a settings write that
      // is still in flight would race the disposal, because writing into a
      // stopped entry reloads it and the restarted chains read again.
      expect(billingValue(ctx).cache).toMatchObject({ total: 12.34 })
      expect(billingValue(ctx).official).toMatchObject({ source: DEFAULT_PRICING_URL })
    })
    await fiber.dispose()
    // Both chains had a next tick armed; disposal cancels it.
    await new Promise((resolve) => { setTimeout(resolve, 700) })
    expect(callsTo(fetchImpl, balanceUrl)).toHaveLength(1)
    expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1)
  })

  it('keeps a refused write from breaking the chain', async () => {
    stubReads()
    const { ctx, fiber } = await bootBilling()
    const warn = vi.spyOn(ctx.logger, 'warn')
    vi.spyOn(ctx.settings, 'update').mockRejectedValue(new Error('storage unavailable'))
    new MemoryCredentials(ctx, { DEEPSEEK_API_KEY: 'key-under-test' })
    await fiber
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(warn.mock.calls[0]?.[0]).toBe('ui-billing: settings write failed')
  })

  it('falls back on the process environment for a reference the store holds no value for', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'env-key')
    const { fetchImpl } = await mount({ config: { apiKeyEnv: 'BILLING_TEST_KEY' }, credentials: {} })
    const balanceUrl = `${DEFAULT_BASE_URL}/user/balance`
    await vi.waitFor(() => { expect(callsTo(fetchImpl, balanceUrl)).toHaveLength(1) })
    expect((callsTo(fetchImpl, balanceUrl)[0]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer env-key' })
  })

  it('drops each read that settles after disposal', async () => {
    // Both chains are left holding an unanswered read, so disposal is what the
    // settlement meets; neither may write a value into a stopped plugin.
    const balance = Promise.withResolvers<Response>()
    const page = Promise.withResolvers<Response>()
    const { ctx, fiber } = await mount({
      answers: { balance: () => balance.promise, prices: () => page.promise },
    })
    const update = vi.spyOn(ctx.settings, 'update')
    await fiber.dispose()
    balance.resolve(Response.json(BALANCE_BODY))
    page.resolve(pageResponse())
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(update).not.toHaveBeenCalled()
    // The entry stopped, so the settings domain no longer describes it.
    expect(billingRow(ctx)).toBeUndefined()
  })

  it('reads the page when the browser asks for it, then clears the request', async () => {
    const { ctx, fetchImpl } = await mount({ config: { pricingRefreshIntervalMs: 1_000 } })
    await vi.waitFor(() => { expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1) })

    // The page's request is a settings write: the live configuration is the
    // one store both halves share, and the Host watches it for exactly this.
    await ctx.settings.update(NS, { officialRequest: Date.now() })
    await vi.waitFor(() => { expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(2) })
    // It stays pending until its read settles, which is how the page shows
    // that read as in flight.
    await vi.waitFor(() => { expect(billingValue(ctx).officialRequest).toBe(null) })
  })

  it('serves one read for a request the page repeated', async () => {
    // The reading is left unanswered, so the repeat lands while it is in
    // flight: the same request twice is not a second read.
    const reading = Promise.withResolvers<Response>()
    const { ctx, fetchImpl } = await mount({ answers: { prices: () => reading.promise } })
    await vi.waitFor(() => { expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1) })
    const asked = Date.now()
    await ctx.settings.update(NS, { officialRequest: asked })
    await ctx.settings.update(NS, { officialRequest: asked })
    // The read start-up began, plus the one the request caused.
    await vi.waitFor(() => { expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(2) })
    reading.resolve(pageResponse())
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(2)
  })

  it('leaves the request field alone for a read nobody asked for', async () => {
    const { ctx } = await mount()
    await vi.waitFor(() => { expect(billingValue(ctx).official).not.toBe(null) })
    // Nobody asked and nobody ever wrote the field: the document omits it.
    expect(billingValue(ctx).officialRequest).toBeUndefined()
  })

  it('waits out the interval rather than re-reading a table it still covers', async () => {
    const { ctx, fetchImpl } = await mount({
      config: {
        pricingRefreshIntervalMs: 86_400_000,
        official: { models: {}, currency: 'CNY', at: Date.now() - 60_000, source: DEFAULT_PRICING_URL },
      },
    })
    // The balance chain still settles, which is what proves the plugin ran: a
    // published price list moves rarely, so a restart inside the interval is
    // not a reason to read the page again.
    await vi.waitFor(() => { expect(billingValue(ctx).cache).toMatchObject({ total: 12.34 }) })
    expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(0)
  })

  it('re-reads a table the interval has passed', async () => {
    const { fetchImpl } = await mount({
      config: {
        pricingRefreshIntervalMs: 86_400_000,
        official: { models: {}, currency: 'CNY', at: Date.now() - 2 * 86_400_000, source: DEFAULT_PRICING_URL },
      },
    })
    await vi.waitFor(() => { expect(callsTo(fetchImpl, DEFAULT_PRICING_URL)).toHaveLength(1) })
  })
})

describe('readBalance', () => {
  const request = {
    baseURL: `${DEFAULT_BASE_URL}/`, apiKeyEnv: 'BILLING_TEST_KEY', currency: 'CNY', timeoutMs: 1_000,
  }

  it('reports a missing credential without a request', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const result = await readBalance(request, fromEnv)
    expect(result.ok).toBe(false)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'noKey', ref: 'BILLING_TEST_KEY' })
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
    const result = await readBalance(request, fromEnv)
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
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? result.balance.currency : undefined).toBe('USD')
  })

  it('refuses each malformed response', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    for (const [body, detail] of [
      // A parse failure's own message is the runtime's, so only the shape of
      // this package's answer is pinned for it; the rest name the gap itself.
      ['not json', undefined],
      ['"scalar"', 'not an object'],
      ['{}', 'no balance_infos array'],
      ['{"balance_infos":[]}', 'no usable amount'],
      ['{"balance_infos":[null]}', 'no usable amount'],
      ['{"balance_infos":["x"]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"CNY"}]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"","total_balance":"1"}]}', 'no usable amount'],
      ['{"balance_infos":[{"currency":"CNY","total_balance":"abc"}]}', 'no usable amount'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))))
      const result = await readBalance(request, fromEnv)
      expect(result.ok, body).toBe(false)
      const failure = result.ok ? undefined : result.failure
      expect(failure?.kind, body).toBe('payload')
      if (detail !== undefined) expect(failure, body).toEqual({ kind: 'payload', detail })
    }
  })

  it('reports a transport failure', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('socket closed'))))
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'socket closed' })
  })

  it('reports a thrown value that is not an Error as its own text', async () => {
    vi.stubEnv('BILLING_TEST_KEY', 'k')
    // A transport can fail with anything at all; the read states what it was
    // given rather than claiming a cause it cannot name.
    vi.stubGlobal('fetch', vi.fn(() => { throw 'closed' }))
    const result = await readBalance(request, fromEnv)
    expect(result.ok ? undefined : result.failure).toEqual({ kind: 'network', detail: 'closed' })
  })
})
