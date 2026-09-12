/**
 * The `ui-billing` settings namespace: its name, value contract, schema, and
 * the pure rate fold both faces share.
 *
 * The value mixes two kinds of fact. `models` is user configuration — one rate
 * row per `provider/model` route, written by the Billing settings page. `cache`
 * is Host-owned state: the newest DeepSeek balance the Host could read, which
 * the browser displays without a Remote of its own.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/settings
 */

import Schema from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const NS = 'ui-billing'

/** Route key separating a provider id from a model id inside one rate-row key. */
export const ROUTE_SEPARATOR = '/'

/**
 * Currency the shipped DeepSeek route bills in, and the display currency both
 * the namespace default and the Host account read start from.
 */
export const DEFAULT_CURRENCY = 'CNY'

/** Per-million-token rates for one route, in the configured display currency. */
export interface ModelRate {
  /** Cached prompt input. */
  cacheHit: number
  /** Uncached prompt input, including cache writes. */
  cacheMiss: number
  /** Model output, reasoning tokens included. */
  output: number
}

/** The three rate fields, in display order. */
export const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'output'] as const

/** One field of {@link ModelRate}. */
export type RateField = (typeof RATE_FIELDS)[number]

/**
 * Parse one user-typed rate.
 * @param text - the input's text.
 * @returns the parsed non-negative number, or undefined when the text is not one.
 */
export function parseRate(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return 0
  const value = Number(trimmed)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** One balance figure the Host read from the provider account API. */
export interface BalanceSnapshot {
  /** Total available balance in {@link BalanceSnapshot.currency}. */
  total: number
  /** Currency the provider reported; a display value, never converted. */
  currency: string
  /** Whether the provider reports the balance as sufficient for further calls. */
  available: boolean
  /** When the Host read it, in epoch milliseconds. */
  at: number
}

/**
 * Why one Host balance read produced no snapshot.
 *
 * The reason is structured rather than a sentence because the browser renders
 * it: the Host half owns the read and the browser owns the copy, so a failure
 * crosses that boundary as a kind plus the values its sentence needs, with the
 * technical detail a person cannot translate riding along for a second line.
 */
export type BalanceFailure =
  /** Nothing held a value for the referenced key. */
  | { readonly kind: 'noKey'; readonly ref: string }
  /** The account API answered with a status other than 200. */
  | { readonly kind: 'http'; readonly status: number }
  /** The request itself did not complete. */
  | { readonly kind: 'network'; readonly detail: string }
  /** The response arrived but could not be read as the documented payload. */
  | { readonly kind: 'payload'; readonly detail: string }

/** The namespace's complete value. */
export interface BillingSettings {
  /**
   * Currency rates are stated in, and the code every cost is displayed with
   * before a balance names its own. A deployment that bills in another
   * currency sets it in the settings document.
   */
  currency: string
  /** Rate rows keyed `provider/model`; absent routes are priced by nothing. */
  models: Record<string, ModelRate>
  /** Newest Host-read balance, or null before the first successful read. */
  cache: BalanceSnapshot | null
  /** Why the newest read failed, or null when it succeeded or never ran. */
  cacheError: BalanceFailure | null
}

/**
 * Compose one rate-row key.
 * @param provider - provider id as the model directory reports it.
 * @param model - model id inside that provider.
 * @returns the `provider/model` key one rate row is stored under.
 */
export function routeKey(provider: string, model: string): string {
  return `${provider}${ROUTE_SEPARATOR}${model}`
}

/**
 * Split a rate-row key back into its route.
 * @param key - a key as {@link routeKey} composes it.
 * @returns the provider and model, or undefined for a key with no model part.
 */
export function splitRouteKey(key: string): { provider: string; model: string } | undefined {
  const at = key.indexOf(ROUTE_SEPARATOR)
  if (at <= 0 || at === key.length - 1) return undefined
  return { provider: key.slice(0, at), model: key.slice(at + 1) }
}

const rateSchema: Schema<ModelRate> = Schema.object({
  cacheHit: Schema.number().default(0),
  cacheMiss: Schema.number().default(0),
  output: Schema.number().default(0),
})

const balanceSchema: Schema<BalanceSnapshot | null> = Schema.union([
  Schema.const(null),
  Schema.object({
    total: Schema.number().default(0),
    currency: Schema.string().default(DEFAULT_CURRENCY),
    available: Schema.boolean().default(true),
    at: Schema.number().default(0),
  }),
])

const failureSchema: Schema<BalanceFailure | null> = Schema.union([
  Schema.const(null),
  Schema.object({ kind: Schema.const('noKey').required(), ref: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('http').required(), status: Schema.number().default(0) }),
  Schema.object({ kind: Schema.const('network').required(), detail: Schema.string().default('') }),
  Schema.object({ kind: Schema.const('payload').required(), detail: Schema.string().default('') }),
])

/** The namespace schema; `settings.register` resolves and validates against it. */
export const BillingSettingsSchema: Schema<BillingSettings> = Schema.object({
  currency: Schema.string().default(DEFAULT_CURRENCY),
  models: Schema.dict(rateSchema).default({}),
  cache: balanceSchema.default(null),
  cacheError: failureSchema.default(null),
})

/** Token buckets one route was billed for, in the provider's own units. */
export interface RouteUsage {
  /** Uncached prompt input, including cache writes. */
  cacheMissTokens: number
  /** Cached prompt input. */
  cacheHitTokens: number
  /** Model output. */
  outputTokens: number
}

/**
 * Price one route's buckets.
 *
 * Rates are per million tokens, so the result is in the configured currency.
 * Every bucket is charged at its own rate; a route with no configured row
 * prices to zero, and the caller decides whether that absence is worth
 * displaying.
 * @param rate - the route's configured rates.
 * @param usage - the route's billed buckets.
 * @returns the cost in the configured currency.
 */
export function priceUsage(rate: ModelRate, usage: RouteUsage): number {
  return (usage.cacheHitTokens * rate.cacheHit
    + usage.cacheMissTokens * rate.cacheMiss
    + usage.outputTokens * rate.output) / 1_000_000
}
