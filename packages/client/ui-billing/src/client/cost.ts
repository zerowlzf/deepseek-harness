/**
 * Cost folds for the billing surfaces.
 *
 * Two folds exist because the two surfaces have different evidence. The
 * session meter accumulates exactly: the `tokenUsage` projection is a running
 * total whose growth between two reads is precisely what one route was billed,
 * so summing those deltas prices a session that switched models mid-way
 * without needing per-route history. The turn meter starts from the durable
 * turn-tail accounting — the same number the shipped Turn-usage panel shows —
 * and prices each attempt at the rate of the route that produced it.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/cost
 */

import type { TurnTokenUsage } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { priceUsage, routeKey, type ModelRate } from '../settings.ts'

/** Rate lookup: one route's configured rates, keyed `provider/model`. */
export type RateTable = Readonly<Record<string, ModelRate>>

/** The four disjoint buckets one session accumulated up to a point. */
export interface SessionBuckets {
  readonly uncachedInputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly outputTokens: number
}

/** One stretch of a session billed under a single route. */
export interface SessionCostStep {
  /** `provider/model` the stretch was billed under. */
  readonly route: string
  /** Buckets billed during the stretch. */
  readonly buckets: SessionBuckets
}

/** Token buckets one turn was billed for. */
export interface TurnBuckets {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** One route that contributed to a turn, with the buckets read for it. */
export interface TurnRouteUsage {
  readonly route: string
  readonly buckets: TurnBuckets
}

/** Priced turn total plus the routes that were priced. */
export interface TurnCost {
  /** Cost of every priced route in the turn. */
  readonly total: number
  /** Routes that had configured rates and contributed to {@link TurnCost.total}. */
  readonly priced: readonly string[]
  /** Routes the turn used that carry no rates, so their share is not in the total. */
  readonly unpriced: readonly string[]
}

/**
 * Read the buckets a session accumulated from its projection value.
 * @param usage - the session's `tokenUsage` projection value.
 * @returns the same four prompt-side and output buckets this package prices.
 */
export function sessionBuckets(usage: TokenUsageProjection): SessionBuckets {
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
  }
}

/**
 * Buckets added between two reads of the running session total.
 * @param previous - the total before the change.
 * @param next - the total after it.
 * @returns each bucket's non-negative growth.
 */
export function bucketDelta(previous: SessionBuckets, next: SessionBuckets): SessionBuckets {
  return {
    uncachedInputTokens: Math.max(0, next.uncachedInputTokens - previous.uncachedInputTokens),
    cacheReadTokens: Math.max(0, next.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, next.cacheWriteTokens - previous.cacheWriteTokens),
    outputTokens: Math.max(0, next.outputTokens - previous.outputTokens),
  }
}

/**
 * Whether one delta carries no billed tokens.
 * @param buckets - one delta or running total.
 * @returns whether every bucket is zero, which means there is nothing to price.
 */
export function isEmptyBuckets(buckets: SessionBuckets): boolean {
  return buckets.uncachedInputTokens === 0
    && buckets.cacheReadTokens === 0
    && buckets.cacheWriteTokens === 0
    && buckets.outputTokens === 0
}

/**
 * Price a session from its billed stretches.
 *
 * A step whose route carries no rates contributes nothing, and the caller
 * reports that absence separately rather than showing a wrong total.
 * @param steps - billed stretches in accumulation order.
 * @param rates - configured rates by route.
 * @returns the priced total in the configured currency.
 */
export function sessionCost(steps: readonly SessionCostStep[], rates: RateTable): number {
  let total = 0
  for (const step of steps) {
    const rate = rates[step.route]
    if (rate === undefined) continue
    total += priceUsage(rate, {
      // Cache writes are billed as uncached input, which is the bucket the
      // provider already reported them in for the prompt-side total.
      cacheMissTokens: step.buckets.uncachedInputTokens + step.buckets.cacheWriteTokens,
      cacheHitTokens: step.buckets.cacheReadTokens,
      outputTokens: step.buckets.outputTokens,
    })
  }
  return total
}

/**
 * Split one turn's exact accounting across its routes.
 *
 * The turn-tail accounting carries one aggregate per bucket plus the set of
 * routes that billed it, and the loaded window carries each attempt's own
 * usage and route. When the attempts account for the same total, their buckets
 * are exact per route. A retried attempt makes the aggregate larger than the
 * surviving samples; that difference is charged at the last route's rate, which
 * keeps the priced total equal to the tokens the provider reported.
 *
 * Without attempts the aggregate is all that is left, and it can be priced only
 * when a single route is named: every billed attempt ran there. Several named
 * routes with no surviving attempt cannot be split, and stating the aggregate
 * under each of them would charge the turn once per route, so the fold declines
 * and returns no rows, leaving the caller to name the routes it could not
 * attribute.
 * @param usage - the turn's exact accounting.
 * @param attempts - loaded attempts of the turn, route by route, in order.
 * @returns one usage row per route, or no rows when the turn cannot be
 * attributed to the routes its own accounting names.
 */
export function turnRouteUsage(
  usage: TurnTokenUsage,
  attempts: readonly { readonly route: string; readonly buckets: TurnBuckets }[],
): TurnRouteUsage[] {
  if (attempts.length === 0) {
    const named = (usage.routes ?? []).map(route => routeKey(route.provider, route.model))
    const [only] = named
    return named.length === 1 && only !== undefined ? [{ route: only, buckets: turnBuckets(usage) }] : []
  }
  const total: TurnBuckets = turnBuckets(usage)
  const summed = attempts.reduce(
    (accumulated, attempt) => ({
      uncachedInputTokens: accumulated.uncachedInputTokens + attempt.buckets.uncachedInputTokens,
      outputTokens: accumulated.outputTokens + attempt.buckets.outputTokens,
      cacheReadTokens: accumulated.cacheReadTokens + attempt.buckets.cacheReadTokens,
      cacheWriteTokens: accumulated.cacheWriteTokens + attempt.buckets.cacheWriteTokens,
    }),
    { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
  const rows: TurnRouteUsage[] = attempts.map(attempt => ({ route: attempt.route, buckets: attempt.buckets }))
  const remainder: TurnBuckets = {
    uncachedInputTokens: total.uncachedInputTokens - summed.uncachedInputTokens,
    outputTokens: total.outputTokens - summed.outputTokens,
    cacheReadTokens: total.cacheReadTokens - summed.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens - summed.cacheWriteTokens,
  }
  if (remainder.uncachedInputTokens !== 0
    || remainder.outputTokens !== 0
    || remainder.cacheReadTokens !== 0
    || remainder.cacheWriteTokens !== 0) {
    const last = rows[rows.length - 1]
    if (last !== undefined) {
      rows[rows.length - 1] = {
        route: last.route,
        buckets: {
          uncachedInputTokens: last.buckets.uncachedInputTokens + remainder.uncachedInputTokens,
          outputTokens: last.buckets.outputTokens + remainder.outputTokens,
          cacheReadTokens: last.buckets.cacheReadTokens + remainder.cacheReadTokens,
          cacheWriteTokens: last.buckets.cacheWriteTokens + remainder.cacheWriteTokens,
        },
      }
    }
  }
  return rows
}

/**
 * One turn's aggregate accounting as priceable buckets.
 * @param usage - the turn's exact accounting.
 * @returns the four buckets, with the absent cache counts read as zero.
 */
function turnBuckets(usage: TurnTokenUsage): TurnBuckets {
  return {
    uncachedInputTokens: usage.uncachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

/**
 * Price one turn's route rows.
 * @param rows - the turn's per-route buckets.
 * @param rates - configured rates by route.
 * @returns the priced total plus which routes were priced.
 */
export function turnCost(rows: readonly TurnRouteUsage[], rates: RateTable): TurnCost {
  let total = 0
  const priced: string[] = []
  const unpriced: string[] = []
  for (const row of rows) {
    const rate = rates[row.route]
    if (rate === undefined) {
      if (!unpriced.includes(row.route)) unpriced.push(row.route)
      continue
    }
    if (!priced.includes(row.route)) priced.push(row.route)
    total += priceUsage(rate, {
      cacheMissTokens: row.buckets.uncachedInputTokens + row.buckets.cacheWriteTokens,
      cacheHitTokens: row.buckets.cacheReadTokens,
      outputTokens: row.buckets.outputTokens,
    })
  }
  return { total, priced, unpriced }
}

/**
 * Routes a turn billed, preferring the durable attribution and falling back to
 * the loaded attempts when the turn-tail accounting withheld it.
 * @param usage - the turn's exact accounting.
 * @param attempts - routes read from the loaded attempts.
 * @returns distinct route keys in first-seen order.
 */
export function turnRoutes(usage: TurnTokenUsage, attempts: readonly string[]): string[] {
  const declared = usage.routes?.map(route => routeKey(route.provider, route.model)) ?? []
  if (declared.length > 0) return declared
  return [...new Set(attempts)]
}
