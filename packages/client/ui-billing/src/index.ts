/**
 * Billing plugin, Host half: owns the `ui-billing` settings namespace and keeps
 * its two account reads fresh.
 *
 * The namespace is the whole Host surface. Rates are user configuration the
 * browser writes through the settings Remote; the balance and the published
 * price table are reads of the provider's own pages, which the browser displays
 * from the same value. Nothing here is model-visible and no route is
 * registered, so mounting this half only adds account facts to the settings
 * document.
 *
 * @module @deepseek-ai/dsh-client-ui-billing
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only: activates the `ctx.settings` Context declaration.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: activates the `ctx.timer` Context declaration and its `ctx.timeout` mixin.
import type {} from '@deepseek-ai/cordis-plugin-timer'
// Type-only: activates the `ctx.credentials` Context declaration.
import type {} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: activates the `ctx.web` Context declaration.
import type {} from '@deepseek-ai/dsh-web'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, readBalance } from './account.ts'
import { DEFAULT_PRICING_URL, readPrices, type PageFetcher } from './published-prices.ts'
import { BillingSettingsSchema, DEFAULT_CURRENCY, NS, type BillingSettings } from './settings.ts'

/**
 * Required services: the namespace owner, the refresh timer, and the credential
 * store. The credential store is a required wait because a read that starts
 * before its document is loaded reports a missing key as though the operator
 * had stored none.
 */
export const inject = ['settings', 'timer', 'credentials']

/** Plugin configuration, all optional. */
export interface Config {
  /** Credential reference holding the DeepSeek API key. */
  apiKeyEnv: string
  /** DeepSeek API base; `/user/balance` is appended. */
  baseURL: string
  /** Currency to report when the account holds several. */
  currency: string
  /** Delay between balance reads; `0` reads once at startup and schedules no further read. */
  refreshIntervalMs: number
  /** Published price page rates are read from. */
  pricingUrl: string
  /** Delay between price reads; `0` reads once at startup and schedules no further read. */
  pricingRefreshIntervalMs: number
  /** Whole-request deadline for one read. */
  requestTimeoutMs: number
}

/** Configuration schema; every key carries the value the plugin uses when unset. */
export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string().default(DEFAULT_BASE_URL),
  currency: Schema.string().default(DEFAULT_CURRENCY),
  refreshIntervalMs: Schema.natural().default(300_000),
  pricingUrl: Schema.string().default(DEFAULT_PRICING_URL),
  pricingRefreshIntervalMs: Schema.natural().default(86_400_000),
  requestTimeoutMs: Schema.natural().default(15_000),
})

/**
 * Register the namespace and start both refresh chains.
 * @param ctx - Host context carrying the settings and timer services.
 * @param config - endpoints, credential, currency, and timing values.
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(NS, BillingSettingsSchema)
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
  // The Host's web capability is the deployment's own retrieval path, so the
  // price read goes through it instead of a request of this package's own. It
  // is optional: a deployment that mounts no web provider still registers the
  // namespace and reads the balance, and the price read reports that it had no
  // page to read.
  const fetchPage = (): PageFetcher | undefined => {
    const web = ctx.get('web')
    return web === undefined ? undefined : (url, signal) => web.fetch({ url }, signal)
  }

  let stopped = false
  const armed = new Set<() => void>()

  /** Arm one chain's next tick, unless the plugin stopped or configured it off. */
  const schedule = (delayMs: number, run: () => Promise<void>): void => {
    if (stopped || delayMs <= 0) return
    const handle = timer.timeout(() => {
      armed.delete(handle)
      void run()
    }, delayMs)
    armed.add(handle)
  }

  /** Commit one read's result. A refused write leaves the previous value in place. */
  const commit = async (patch: Partial<BillingSettings>): Promise<void> => {
    try {
      await scope.update(patch)
    } catch (error: unknown) {
      ctx.logger.warn('ui-billing: settings write failed')
      ctx.logger.warn(error)
    }
  }

  const refreshBalance = async (): Promise<void> => {
    const result = await readBalance({
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      currency: config.currency,
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

  const refreshPrices = async (): Promise<void> => {
    const result = await readPrices({
      url: config.pricingUrl,
      currency: config.currency,
      timeoutMs: config.requestTimeoutMs,
    }, fetchPage())
    if (stopped) return
    // Prices move far less often than a balance does, and a failed read keeps
    // the previous table: the shipped snapshot still prices the official routes.
    await commit(result.ok
      ? {
        official: {
          models: result.prices.models,
          currency: result.prices.currency,
          at: Date.now(),
          source: config.pricingUrl,
        },
        officialError: null,
      }
      : { officialError: result.failure })
    schedule(config.pricingRefreshIntervalMs, refreshPrices)
  }

  ctx.effect(() => {
    void refreshBalance()
    void refreshPrices()
    return () => {
      stopped = true
      for (const handle of armed) handle()
      armed.clear()
    }
  }, 'ui-billing: account reads')
}
