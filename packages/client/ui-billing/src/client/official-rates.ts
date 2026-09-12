/**
 * Published DeepSeek prices, used as the fallback rate for the official
 * provider's routes.
 *
 * The page still owns the numbers: a route the user has priced is billed at
 * that row, and these values fill in the official routes nobody has priced, so
 * an official session reads a cost out of the box. They are the provider's
 * published per-million-token prices for the model ids the shipped adapter
 * reports; a deployment billed differently overrides them per route, and
 * clearing a stored row returns the route to these.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/official-rates
 */

import type { ModelRate } from '../settings.ts'
import type { RateTable } from './cost.ts'
import { OFFICIAL_PROVIDER } from './routes.ts'

/**
 * Route → published rate, keyed `provider/model` exactly as stored rates are.
 * Cache prices are the peak values the provider publishes; off-peak windows are
 * half of them, which the fold cannot apply because no bucket carries a time.
 */
export const OFFICIAL_RATES: RateTable = {
  [`${OFFICIAL_PROVIDER}/deepseek-v4-flash`]: { cacheHit: 0.021, cacheMiss: 1.07, output: 4.26 },
  [`${OFFICIAL_PROVIDER}/deepseek-v4-flash-vision-exp`]: { cacheHit: 0.021, cacheMiss: 1.07, output: 4.26 },
  [`${OFFICIAL_PROVIDER}/deepseek-v4-pro`]: { cacheHit: 0.16, cacheMiss: 4.7, output: 14.1 },
  [`${OFFICIAL_PROVIDER}/deepseek-flash`]: { cacheHit: 0.021, cacheMiss: 1.07, output: 4.26 },
}

/**
 * Rates to price a session with: every stored row, plus the published official
 * price for each official route the document does not price itself.
 * @param stored - the namespace's stored rate rows, if any.
 * @returns the rate table the folds price with.
 */
export function effectiveRates(stored: Readonly<Record<string, ModelRate>> | undefined): RateTable {
  return { ...OFFICIAL_RATES, ...stored }
}

/**
 * The published rate one route falls back to.
 * @param route - a `provider/model` key.
 * @returns the published rate, or undefined when this route has none.
 */
export function defaultRateOf(route: string): ModelRate | undefined {
  return OFFICIAL_RATES[route]
}
