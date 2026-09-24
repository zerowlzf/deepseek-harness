/**
 * Billing plugin, Host half: owns the live `ui-billing` configuration fields
 * and keeps its two account reads fresh.
 *
 * The plugin's own profile entry is the whole Host surface. Rates and the
 * display currency are user configuration the browser writes through the
 * settings Remote; the balance and the published price table are reads of the
 * provider's own pages, which the browser displays from the same value. The
 * billing fields are volatile, so the settings domain edits them without
 * remounting this plugin and its refresh chains survive every such write.
 * Nothing here is model-visible and no route is registered, so mounting this
 * half only adds account facts to the settings document.
 *
 * @module @deepseek-ai/dsh-client-ui-billing
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: activates the `ctx.settings` Context declaration.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: activates the `loader/volatile-update` Events declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: activates the `ctx.timer` Context declaration.
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: activates the `ctx.credentials` Context declaration.
import type {} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, readBalance } from './account.ts'
import { DEFAULT_PRICING_URL, fetchPageNative, readPrices } from './published-prices.ts'
import {
  balanceSchema, DEFAULT_CURRENCY, failureSchema, fillBillingSettings, NS,
  priceFailureSchema, priceSnapshotSchema, rateSchema,
  type BalanceSnapshot, type BillingSettings, type ModelRate,
  type PriceFailure, type PriceSnapshot, type ReadFailure,
} from './settings.ts'

/**
 * Required services: the live-configuration editor, the refresh timer, and the
 * credential store. The credential store is a required wait because a read that
 * starts before its document is loaded reports a missing key as though the
 * operator had stored none.
 */
export const inject = ['settings', 'timer', 'credentials']

/** Plugin configuration: endpoint and timing fields, plus the live billing fields. */
export interface Config {
  /** Credential reference holding the DeepSeek API key. */
  apiKeyEnv: string
  /** DeepSeek API base; `/user/balance` is appended. */
  baseURL: string
  /** Delay between balance reads; `0` reads once at startup and schedules no further read. */
  refreshIntervalMs: number
  /** Published price page rates are read from. */
  pricingUrl: string
  /**
   * Delay between automatic price reads. A published price list moves rarely,
   * so the wait is long and a restart inside it does not re-read a fresh table;
   * `0` reads once at startup and schedules no further read. The page can ask
   * for a read at any time whatever this value is.
   */
  pricingRefreshIntervalMs: number
  /** Whole-request deadline for one read. */
  requestTimeoutMs: number
  /** Currency to report and price in when the user has set none. */
  currency: Volatile<string>
  /** Rate rows keyed `provider/model`; absent routes are priced by nothing. */
  models: Volatile<Record<string, ModelRate>>
  /** Newest Host-read balance; `undefined` until a read writes one, `null` when a write cleared it. */
  cache: Volatile<BalanceSnapshot | null | undefined>
  /** Why the newest balance read failed; `undefined` before the first read, `null` when the read succeeded. */
  cacheError: Volatile<ReadFailure | null | undefined>
  /** Newest Host-read published price table; `undefined` until a read writes one, `null` when a write cleared it. */
  official: Volatile<PriceSnapshot | null | undefined>
  /** Why the newest price read failed; `undefined` before the first read, `null` when the read succeeded. */
  officialError: Volatile<PriceFailure | null | undefined>
  /**
   * A price read the browser asked for, as the moment it asked;
   * `undefined` while nobody has ever asked, `null` while no request is
   * pending. The Host clears the field when the requested read settles.
   */
  officialRequest: Volatile<number | null | undefined>
}

/**
 * Configuration schema; every key carries the value the plugin uses when unset,
 * except the five state fields, which carry none on purpose: a volatile field
 * the document has not written is an absent key whose reference reads
 * `undefined`, and consumers read that absence as `null` through
 * {@link fillBillingSettings}. The billing fields are marked live so the
 * settings domain edits them without remounting this plugin.
 */
export const Config = z.object({
  apiKeyEnv: z.string().default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  refreshIntervalMs: z.natural().default(300_000),
  pricingUrl: z.string().default(DEFAULT_PRICING_URL),
  pricingRefreshIntervalMs: z.natural().default(15 * 86_400_000),
  requestTimeoutMs: z.natural().default(15_000),
  currency: z.string().default(DEFAULT_CURRENCY).volatile(),
  models: z.dict(rateSchema).default({}).volatile(),
  cache: balanceSchema.volatile(),
  cacheError: failureSchema.volatile(),
  official: priceSnapshotSchema.volatile(),
  officialError: priceFailureSchema.volatile(),
  officialRequest: z.union([z.const(null), z.number()]).volatile(),
})

/**
 * Keep the live configuration current and start both refresh chains.
 * @param ctx - Host context carrying the settings, timer, and credentials services.
 * @param config - endpoints, credential, and timing values plus the live billing fields.
 */
export function apply(ctx: Context, config: Config): void {
  // The generated configuration form would offer the balance and price-table
  // fields for editing; the plugin's own Billing page is the one surface that
  // should write them, so the generated form stays out of the Plugins page.
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), 'ui-billing: own settings page instead of the generated form')

  // The timer service's own methods are used directly: the Context mixin
  // delegates to `this.ctx`, whose fiber is the service — an effect armed
  // through it would belong to the service, not to this plugin.
  const timer = ctx.timer
  // The credential store is a declared injection, so it is initialized before
  // this runs; the environment covers a store that holds no value for the
  // reference. The reference is the operator's own configuration value, taken
  // as written: the seam refuses a malformed one through its own lookup.
  const resolveKey = async (): Promise<string | undefined> => {
    const resolved = await ctx.credentials.resolve(config.apiKeyEnv as CredentialRef)
    return resolved?.value ?? process.env[config.apiKeyEnv]
  }

  /** The live billing fields as one settings value, absent state fields read as `null`. */
  const billing = (): BillingSettings => fillBillingSettings({
    currency: config.currency.get(),
    models: config.models.get(),
    cache: config.cache.get(),
    cacheError: config.cacheError.get(),
    official: config.official.get(),
    officialError: config.officialError.get(),
    officialRequest: config.officialRequest.get(),
  })

  let stopped = false
  const armed = new Set<() => void>()
  let priceTimer: (() => void) | undefined

  /**
   * Arm one chain's next tick, unless the plugin stopped or configured it off.
   * @param delayMs - wait before the tick; `0` arms nothing.
   * @param run - the chain, which re-arms itself when it settles.
   * @returns the handle that cancels this tick, or undefined when none was armed.
   */
  const schedule = (delayMs: number, run: () => Promise<void>): (() => void) | undefined => {
    if (stopped || delayMs <= 0) return undefined
    const handle = timer.timeout(() => {
      armed.delete(handle)
      void run()
    }, delayMs)
    armed.add(handle)
    return handle
  }

  /** Commit one read's result into the live configuration. A refused write leaves the previous value in place. */
  const commit = async (patch: Partial<BillingSettings>): Promise<void> => {
    try {
      await ctx.settings.update(NS, patch)
    } catch (error: unknown) {
      ctx.logger.warn('ui-billing: settings write failed')
      ctx.logger.warn(error)
    }
  }

  const refreshBalance = async (): Promise<void> => {
    const result = await readBalance({
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      currency: config.currency.get(),
      timeoutMs: config.requestTimeoutMs,
    }, resolveKey)
    if (stopped) return
    // A failed refresh keeps the previous snapshot: a stale amount with its
    // timestamp is more useful than an empty field, and the reason says why.
    await commit(result.ok
      ? { cache: result.balance, cacheError: null }
      : { cacheError: result.failure })
    schedule(config.refreshIntervalMs, refreshBalance)
  }

  /**
   * Arm the price chain's next automatic read.
   *
   * The wait is what the stored table has left of the interval rather than a
   * whole one, so a restart inside the interval waits instead of re-reading a
   * table the provider has not changed. Every settlement re-arms through here,
   * and arming replaces the outstanding timer: a read the page asked for moves
   * the automatic one out by a full interval rather than adding a second timer.
   * @param full - wait a whole interval, whatever the stored table's age.
   */
  const armPriceRead = (full = false): void => {
    const interval = config.pricingRefreshIntervalMs
    const at = billing().official?.at
    const age = at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at
    // A table nobody has read, a table older than the interval, and an interval
    // of 0 are all due at once; a settlement that just happened waits a whole one.
    const due = full ? interval : Math.max(0, interval - age)
    priceTimer?.()
    priceTimer = undefined
    if (due <= 0) {
      void refreshPrices()
      return
    }
    priceTimer = schedule(due, refreshPrices)
  }

  const refreshPrices = async (): Promise<void> => {
    // A request the page made stays pending until this read settles, whichever
    // way it went, so the page can show that read as in flight. The field is
    // absent until something writes it, which is no request either.
    const requested = billing().officialRequest != null
    const result = await readPrices({
      url: config.pricingUrl,
      currency: config.currency.get(),
      timeoutMs: config.requestTimeoutMs,
    }, fetchPageNative)
    if (stopped) return
    // Prices move far less often than a balance does, and a failed read keeps
    // the previous table: the shipped snapshot still prices the official routes.
    const outcome: Partial<BillingSettings> = result.ok
      ? {
        official: {
          models: result.prices.models,
          currency: result.prices.currency,
          at: Date.now(),
          source: config.pricingUrl,
        },
        officialError: null,
      }
      : { officialError: result.failure }
    await commit(requested ? { ...outcome, officialRequest: null } : outcome)
    if (config.pricingRefreshIntervalMs > 0) armPriceRead(true)
  }

  // A price read the page asked for: the live configuration is the one store
  // both halves share, and the Host is the half that can read the page at all
  // (the documentation origin serves the browser no readable response). The
  // event carries only the changed paths, so the value itself tells a fresh
  // request from the Host's own clearing of a served one. A request is served
  // once; the Host's own clearing of the field is not one.
  let lastSeenRequest: number | null = billing().officialRequest
  ctx.on('loader/volatile-update', () => {
    const requested = billing().officialRequest
    if (requested === lastSeenRequest) return
    lastSeenRequest = requested
    if (requested != null) void refreshPrices()
  })

  ctx.effect(() => {
    void refreshBalance()
    armPriceRead()
    return () => {
      stopped = true
      for (const handle of armed) handle()
      armed.clear()
      priceTimer = undefined
    }
  }, 'ui-billing: account reads')
}
