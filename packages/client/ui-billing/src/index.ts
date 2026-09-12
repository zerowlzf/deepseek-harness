/**
 * Billing plugin, Host half: owns the `ui-billing` settings namespace and keeps
 * its DeepSeek balance cache fresh.
 *
 * The namespace is the whole Host surface. Rates are user configuration the
 * browser writes through the settings Remote; the balance is a Host read the
 * browser displays from the same value. Nothing here is model-visible and no
 * route is registered, so mounting this half only adds account facts to the
 * settings document.
 *
 * @module @deepseek-ai/dsh-client-ui-billing
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Type-only: activates the `ctx.settings` Context declaration.
import type {} from '@deepseek-ai/dsh-settings'
// Type-only: activates the `ctx.timer` Context declaration and its `ctx.timeout` mixin.
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { DEFAULT_API_KEY_ENV, DEFAULT_BASE_URL, readBalance } from './account.ts'
import { BillingSettingsSchema, DEFAULT_CURRENCY, NS } from './settings.ts'

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
  /** Whole-request deadline for one read. */
  requestTimeoutMs: number
}

/** Configuration schema; every key carries the value the plugin uses when unset. */
export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string().default(DEFAULT_BASE_URL),
  currency: Schema.string().default(DEFAULT_CURRENCY),
  refreshIntervalMs: Schema.natural().default(300_000),
  requestTimeoutMs: Schema.natural().default(15_000),
})

/**
 * Register the namespace and start the balance refresh chain.
 * @param ctx - Host context carrying the settings and timer services.
 * @param config - endpoint, credential, currency, and timing values.
 */
export function apply(ctx: Context, config: Config): void {
  const scope = ctx.settings.register(NS, BillingSettingsSchema)
  // The timer service's own methods are used directly: the Context mixin
  // delegates to `this.ctx`, whose fiber is the service — an effect armed
  // through it would belong to the service, not to this plugin.
  const timer = ctx.timer

  let stopped = false
  let pending: (() => void) | undefined
  const schedule = (delayMs: number): void => {
    if (stopped || delayMs <= 0) return
    pending = timer.timeout(() => {
      pending = undefined
      void refresh()
    }, delayMs)
  }

  const refresh = async (): Promise<void> => {
    const result = await readBalance(ctx, {
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      currency: config.currency,
      timeoutMs: config.requestTimeoutMs,
    })
    if (stopped) return
    // A failed refresh keeps the previous snapshot: a stale amount with its
    // timestamp is more useful than an empty field, and the error says why.
    try {
      await scope.update(result.ok
        ? { cache: result.balance, cacheError: null }
        : { cacheError: result.error })
    } catch (error: unknown) {
      // A refused write leaves the previous cache in place; the next tick retries.
      ctx.logger.warn('ui-billing: balance cache write failed')
      ctx.logger.warn(error)
    }
    schedule(config.refreshIntervalMs)
  }

  ctx.effect(() => {
    void refresh()
    return () => {
      stopped = true
      pending?.()
      pending = undefined
    }
  }, 'ui-billing: balance refresh chain')
}
