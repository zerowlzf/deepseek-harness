/**
 * The `ui-billing` settings namespace: its name, value contract, schema, and
 * the pure rate fold both faces share.
 *
 * The value mixes three kinds of fact. `models` and `currency` are user
 * configuration — one rate row per `provider/model` route and the currency
 * they are stated in, written by the Billing settings page. `cache` and
 * `official` are Host-owned state: the newest DeepSeek balance and the newest
 * published price table the Host could read, which the browser displays
 * without a Remote of its own.
 *
 * The namespace is this plugin's own profile entry: the fields below are its
 * live configuration, and the volatile marks on the plugin `Config` schema are
 * what let the settings domain edit them without remounting the plugin.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/settings
 */

import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
export const NS = 'ui-billing'

/** Route key separating a provider id from a model id inside one rate-row key. */
export const ROUTE_SEPARATOR = '/'

/**
 * Currency the shipped DeepSeek route bills in, and the display currency both
 * the namespace default and the Host account read start from.
 */
export const DEFAULT_CURRENCY = 'CNY'

/** Per-million-token rates for one route during one of a provider's price windows. */
export interface RateBand {
  /** Cached prompt input. */
  cacheHit: number
  /** Uncached prompt input, including cache writes. */
  cacheMiss: number
  /** Model output, reasoning tokens included. */
  output: number
}

/**
 * One route's rates, in the configured display currency.
 *
 * The three flat fields are the peak band, which is what a provider publishing
 * a single price charges at every hour. `offPeak` is the band charged outside
 * that provider's peak window; a row without one costs the same all day, which
 * is the honest reading of a provider that publishes one figure.
 */
export interface ModelRate extends RateBand {
  /** Rates charged outside the peak window; absent means one price at every hour. */
  offPeak?: RateBand | undefined
}

/** The three rate fields, in display order, within one band. */
export const RATE_FIELDS = ['cacheHit', 'cacheMiss', 'output'] as const

/** Which of a provider's two daily price windows a moment falls in. */
export type PriceWindow = 'peak' | 'offPeak'

/** Beijing runs on UTC+8 with no daylight saving, and the published window is stated there. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * The price window in force at one moment.
 *
 * DeepSeek's published price page defines peak as Beijing time Monday–Friday
 * 09:00–12:00 and 14:00–18:00, and every other hour as off-peak at half the
 * peak rates. That window is the provider's published rule rather than a
 * deployment choice, so it is fixed here; a deployment billed on another
 * calendar overrides the affected routes' rates instead.
 * @param at - epoch milliseconds.
 * @returns the window in force at that instant.
 */
export function priceWindowAt(at: number): PriceWindow {
  const beijing = new Date(at + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return 'offPeak'
  const hour = beijing.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18) ? 'peak' : 'offPeak'
}

/**
 * The rates one route charged in one window.
 * @param rate - the route's stored or published row.
 * @param window - the window the charge falls in.
 * @returns the off-peak band while off-peak is in force, otherwise the row's own three figures.
 */
export function bandFor(rate: ModelRate, window: PriceWindow): RateBand {
  if (window === 'offPeak' && rate.offPeak !== undefined) return rate.offPeak
  return { cacheHit: rate.cacheHit, cacheMiss: rate.cacheMiss, output: rate.output }
}

/**
 * The rates one route charged at one moment.
 * @param rate - the route's stored or published row.
 * @param at - epoch milliseconds the charge is attributed to.
 * @returns the band in force at that instant.
 */
export function bandAt(rate: ModelRate, at: number): RateBand {
  return bandFor(rate, priceWindowAt(at))
}

/**
 * Whether one route's rates depend on the window.
 * @param rate - the route's stored or published row, or undefined when it has none.
 * @returns whether the row states an off-peak band, which is what a surface names a window for.
 */
export function pricesByWindow(rate: ModelRate | undefined): boolean {
  return rate?.offPeak !== undefined
}

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
 * Why one Host read produced no value.
 *
 * The reason is structured rather than a sentence because the browser renders
 * it: the Host half owns the read and the browser owns the copy, so a failure
 * crosses that boundary as a kind plus the values its sentence needs, with the
 * technical detail a person cannot translate riding along for a second line.
 */
export type ReadFailure =
  | {
    /** Nothing held a value for the referenced key. */
    readonly kind: 'noKey'
    /** The credential reference no value was held for. */
    readonly ref: string
  }
  | {
    /** The endpoint answered with a status other than 200. */
    readonly kind: 'http'
    /** The status the endpoint answered with. */
    readonly status: number
  }
  | {
    /** The request itself did not complete. */
    readonly kind: 'network'
    /** Why the transport failed, as the transport reported it. */
    readonly detail: string
  }
  | {
    /** The response arrived but could not be read as the documented payload. */
    readonly kind: 'payload'
    /** The payload as far as the reader could capture it. */
    readonly detail: string
  }

/** Why the balance read produced no snapshot. */
export type BalanceFailure = ReadFailure

/** Why the price read produced no usable table. */
export type PriceFailure =
  | Exclude<ReadFailure, {
    /** The arm this union drops: a price page needs no key, so a missing key is never its failure. */
    readonly kind: 'noKey'
  }>
  | {
    /**
     * The deployment mounted no web capability, so no page could be read.
     * Reads since the native-`fetch` port never produce this arm; it stays in
     * the union because a persisted failure from before the port still carries
     * it and the settings schema still validates it.
     */
    readonly kind: 'noWeb'
  }
  | {
    /** The page states its figures in a currency the deployment does not price in. */
    readonly kind: 'currency'
    /** Currency the page states its figures in. */
    readonly found: string
    /** Currency the deployment prices in. */
    readonly expected: string
  }

/** Rates the Host read from the provider's published price page. */
export interface PriceSnapshot {
  /** Model id → published rates, both windows, exactly as that page states them. */
  models: Record<string, ModelRate>
  /** Currency the page states its figures in. */
  currency: string
  /** When the Host read it, in epoch milliseconds. */
  at: number
  /** Page the figures came from. */
  source: string
}

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
  /** Why the newest balance read failed, or null when it succeeded or never ran. */
  cacheError: ReadFailure | null
  /** Newest Host-read published price table, or null before the first successful read. */
  official: PriceSnapshot | null
  /** Why the newest price read failed, or null when it succeeded or never ran. */
  officialError: PriceFailure | null
  /**
   * A price read the browser asked for, as the moment it asked, or null when
   * none is pending.
   *
   * A published price list moves rarely, so the automatic read is long-spaced
   * and a restart inside that interval does not re-read a fresh table. The page
   * is what knows someone wants the figures now, and the settings document is
   * the one store both halves share, so the request travels as this write: the
   * Host reads the page and clears the field when that read settles.
   */
  officialRequest: number | null
}

/**
 * The namespace value as the settings document carries it: any subset of the
 * fields, plain JSON. A volatile state field nothing has written is an absent
 * key, so every state field may be missing from a document that has carried
 * no read, and {@link fillBillingSettings} owns what absence reads as.
 */
export type SparseBillingSettings = {
  [K in keyof BillingSettings]?: BillingSettings[K] | undefined
}

/**
 * Fill the document value's absent fields with what they read as.
 *
 * Both halves read the namespace through here at their boundary with the
 * document — the Host when it snapshots its live references, the browser
 * when it mirrors the described value — so each surface sees the complete
 * value: `null` naming a state field that holds nothing yet, and the schema
 * defaults standing in for the user fields a degenerate document omits.
 * @param value - the namespace value as the document carries it.
 * @returns the value with every field present.
 */
export function fillBillingSettings(value: SparseBillingSettings): BillingSettings {
  return {
    currency: value.currency ?? DEFAULT_CURRENCY,
    models: value.models ?? {},
    cache: value.cache ?? null,
    cacheError: value.cacheError ?? null,
    official: value.official ?? null,
    officialError: value.officialError ?? null,
    officialRequest: value.officialRequest ?? null,
  }
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

/** One price band as the settings document carries it; absent figures read as 0. */
export const bandSchema: z<RateBand> = z.object({
  cacheHit: z.number().default(0),
  cacheMiss: z.number().default(0),
  output: z.number().default(0),
})

/**
 * One route's rates as the settings document carries them.
 *
 * The optional band is a union with `undefined` rather than a bare nested
 * object: a nested object resolves an absent key into a band of zeroes, which
 * would bill every off-peak hour at nothing instead of at the peak rate.
 */
export const rateSchema: z<ModelRate> = z.object({
  cacheHit: z.number().default(0),
  cacheMiss: z.number().default(0),
  output: z.number().default(0),
  offPeak: z.union([z.const(undefined), bandSchema]),
})

/** A balance snapshot or null, as the settings document carries it. */
export const balanceSchema: z<BalanceSnapshot | null> = z.union([
  z.const(null),
  z.object({
    total: z.number().default(0),
    currency: z.string().default(DEFAULT_CURRENCY),
    available: z.boolean().default(true),
    at: z.number().default(0),
  }),
])

/**
 * A balance-read failure or null, as the settings document carries it. The
 * member schemas repeat the type's arms one-for-one rather than sharing one
 * array: a union's members are inferred from the literal array it is given, and
 * an annotated array of member schemas is not assignable to it.
 */
export const failureSchema: z<BalanceFailure | null> = z.union([
  z.const(null),
  z.object({ kind: z.const('noKey').required(), ref: z.string().default('') }),
  z.object({ kind: z.const('http').required(), status: z.number().default(0) }),
  z.object({ kind: z.const('network').required(), detail: z.string().default('') }),
  z.object({ kind: z.const('payload').required(), detail: z.string().default('') }),
])

/**
 * A price-read failure or null, as the settings document carries it. The member
 * schemas repeat the type's arms for the reason {@link failureSchema} states.
 */
export const priceFailureSchema: z<PriceFailure | null> = z.union([
  z.const(null),
  z.object({ kind: z.const('http').required(), status: z.number().default(0) }),
  z.object({ kind: z.const('network').required(), detail: z.string().default('') }),
  z.object({ kind: z.const('payload').required(), detail: z.string().default('') }),
  z.object({ kind: z.const('noWeb').required() }),
  z.object({
    kind: z.const('currency').required(),
    found: z.string().default(''),
    expected: z.string().default(''),
  }),
])

/** A published price table or null, as the settings document carries it. */
export const priceSnapshotSchema: z<PriceSnapshot | null> = z.union([
  z.const(null),
  z.object({
    models: z.dict(rateSchema).default({}),
    currency: z.string().default(DEFAULT_CURRENCY),
    at: z.number().default(0),
    source: z.string().default(''),
  }),
])

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
 * Price one route's buckets under one band.
 *
 * Rates are per million tokens, so the result is in the configured currency.
 * Every bucket is charged at its own rate; a route with no configured row
 * prices to zero, and the caller decides whether that absence is worth
 * displaying.
 * @param rate - the rates in force for this charge, as {@link bandAt} selects them.
 * @param usage - the route's billed buckets.
 * @returns the cost in the configured currency.
 */
export function priceUsage(rate: RateBand, usage: RouteUsage): number {
  return (usage.cacheHitTokens * rate.cacheHit
    + usage.cacheMissTokens * rate.cacheMiss
    + usage.outputTokens * rate.output) / 1_000_000
}
