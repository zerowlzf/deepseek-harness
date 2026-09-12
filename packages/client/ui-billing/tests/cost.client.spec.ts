/**
 * ui-billing pure folds: the cost arithmetic, the magnitude-adaptive money
 * format, the rate parser, and the provider-route discovery join. These are
 * the pieces the three surfaces share, so they are specified once here rather
 * than through each renderer.
 */
import { describe, expect, it } from 'vitest'
import type { ModelRate, RouteUsage } from '../src/settings.ts'
import { parseRate, priceUsage, routeKey, splitRouteKey } from '../src/settings.ts'
import {
  bucketDelta, isEmptyBuckets, sessionCost, turnCost, turnRouteUsage,
  turnRoutes, type SessionBuckets, type TurnRouteUsage,
} from '../src/client/cost.ts'
import { ageOf, currencySymbol, formatAmount, formatBalance } from '../src/client/format.ts'
import { modelIdsOf, providerRoutes, valueAtPath } from '../src/client/routes.ts'

const FLASH: ModelRate = { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }

function buckets(partial: Partial<SessionBuckets> = {}): SessionBuckets {
  return {
    uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, ...partial,
  }
}

describe('rate rows', () => {
  it('composes and splits one provider/model key', () => {
    expect(routeKey('bai', 'glm-5.3-flash')).toBe('bai/glm-5.3-flash')
    expect(splitRouteKey('bai/glm-5.3-flash')).toEqual({ provider: 'bai', model: 'glm-5.3-flash' })
  })

  it('refuses a key that names no model', () => {
    expect(splitRouteKey('bai')).toBeUndefined()
    expect(splitRouteKey('/model')).toBeUndefined()
    expect(splitRouteKey('provider/')).toBeUndefined()
  })
})

describe('priceUsage', () => {
  it('charges each bucket at its own rate per million tokens', () => {
    const usage: RouteUsage = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(priceUsage(FLASH, usage)).toBeCloseTo(0.15 + 4.5 + 13.5, 10)
  })

  it('prices an empty bucket set at zero', () => {
    expect(priceUsage(FLASH, { cacheHitTokens: 0, cacheMissTokens: 0, outputTokens: 0 })).toBe(0)
  })
})

describe('session accumulation', () => {
  it('reads each bucket delta and never negative', () => {
    const delta = bucketDelta(
      buckets({ uncachedInputTokens: 10, outputTokens: 5 }),
      buckets({ uncachedInputTokens: 3, cacheReadTokens: 7, outputTokens: 9 }),
    )
    expect(delta).toEqual({
      uncachedInputTokens: 0, cacheReadTokens: 7, cacheWriteTokens: 0, outputTokens: 4,
    })
  })

  it('reports an empty delta', () => {
    expect(isEmptyBuckets(buckets())).toBe(true)
    expect(isEmptyBuckets(buckets({ outputTokens: 1 }))).toBe(false)
  })

  it('prices each stretch under its own route and skips unpriced ones', () => {
    const total = sessionCost([
      { route: 'bai/glm-5.3-flash', buckets: buckets({ uncachedInputTokens: 1_000_000, outputTokens: 1_000_000 }) },
      { route: 'bai/unpriced', buckets: buckets({ outputTokens: 1_000_000 }) },
      { route: 'bai/glm-5.3-flash', buckets: buckets({ outputTokens: 1_000_000 }) },
    ], { 'bai/glm-5.3-flash': FLASH })
    expect(total).toBeCloseTo(4.5 + 13.5 + 13.5, 10)
  })

  it('charges cache writes as uncached input', () => {
    const total = sessionCost(
      [{ route: 'r', buckets: buckets({ cacheWriteTokens: 1_000_000 }) }],
      { r: FLASH },
    )
    expect(total).toBeCloseTo(4.5, 10)
  })
})

describe('turn splits', () => {
  const turnBuckets = (uncachedInputTokens: number, outputTokens: number) => ({
    uncachedInputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0,
  })

  it('keeps per-attempt buckets when the attempts account for the total', () => {
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      { route: 'a/m', buckets: turnBuckets(10, 2) },
      { route: 'b/m', buckets: turnBuckets(20, 3) },
    ])
    expect(rows).toEqual([
      { route: 'a/m', buckets: turnBuckets(10, 2) },
      { route: 'b/m', buckets: turnBuckets(20, 3) },
    ])
  })

  it('charges a retried attempt remainder at the last route', () => {
    const usage = {
      uncachedInputTokens: 50, outputTokens: 9, totalTokens: 59, cacheReadTokens: 0, cacheWriteTokens: 0,
    }
    const rows = turnRouteUsage(usage, [
      { route: 'a/m', buckets: turnBuckets(10, 2) },
      { route: 'b/m', buckets: turnBuckets(20, 3) },
    ])
    expect(rows).toEqual([
      { route: 'a/m', buckets: turnBuckets(10, 2) },
      { route: 'b/m', buckets: turnBuckets(40, 7) },
    ])
  })

  it('has no rows without loaded attempts', () => {
    expect(turnRouteUsage({
      uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
    }, [])).toEqual([])
  })

  it('prices an unattempted turn under its single named route', () => {
    // One named route is exact even with no surviving attempt: every billed
    // attempt ran there.
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35,
      routes: [{ provider: 'a', model: 'm' }],
    }
    expect(turnRouteUsage(usage, [])).toEqual([{ route: 'a/m', buckets: turnBuckets(30, 5) }])
  })

  it('declines a turn whose several routes have no surviving attempt', () => {
    // Stating the aggregate under each route would charge the turn once per
    // route, so the fold returns nothing and the caller names what it could not
    // attribute.
    const usage = {
      uncachedInputTokens: 30, outputTokens: 5, totalTokens: 35,
      routes: [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'n' }],
    }
    expect(turnRouteUsage(usage, [])).toEqual([])
    expect(turnCost(turnRouteUsage(usage, []), { 'a/m': FLASH, 'b/n': FLASH }).total).toBe(0)
  })

  it('prices priced rows, reports unpriced routes, and counts each route once', () => {
    const rows: TurnRouteUsage[] = [
      { route: 'a/m', buckets: turnBuckets(1_000_000, 1_000_000) },
      { route: 'x/m', buckets: turnBuckets(5, 5) },
      { route: 'a/m', buckets: turnBuckets(1_000_000, 0) },
    ]
    const cost = turnCost(rows, { 'a/m': FLASH })
    expect(cost.total).toBeCloseTo(4.5 + 13.5 + 4.5, 10)
    expect(cost.priced).toEqual(['a/m'])
    expect(cost.unpriced).toEqual(['x/m'])
  })

  it('prefers durable route attribution over the loaded attempts', () => {
    expect(turnRoutes({
      uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
      routes: [{ provider: 'a', model: 'm' }],
    }, ['b/n'])).toEqual(['a/m'])
    expect(turnRoutes({
      uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2,
    }, ['b/n', 'b/n', 'c/o'])).toEqual(['b/n', 'c/o'])
  })
})

describe('money format', () => {
  it('widens precision as the amount shrinks', () => {
    expect(formatAmount(0, 'CNY')).toBe('¥0.00')
    expect(formatAmount(0.0000042, 'CNY')).toBe('¥0.000004')
    expect(formatAmount(0.0042, 'CNY')).toBe('¥0.00420')
    expect(formatAmount(0.042, 'CNY')).toBe('¥0.0420')
    expect(formatAmount(0.42, 'CNY')).toBe('¥0.420')
    expect(formatAmount(4.2, 'CNY')).toBe('¥4.20')
    expect(formatAmount(42_000, 'CNY')).toBe('¥42000')
  })

  it('keeps two decimals on a balance and drops the sign it cannot render', () => {
    expect(formatBalance(12.345, 'CNY')).toBe('¥12.35')
    expect(formatBalance(0, 'USD')).toBe('$0.00')
    expect(formatBalance(0.004, 'EUR')).toBe('€0.0040')
    expect(formatAmount(Number.NaN, 'CNY')).toBe('-')
    expect(formatBalance(Number.POSITIVE_INFINITY, 'CNY')).toBe('-')
  })

  it('falls back to the yuan sign for an unknown currency code', () => {
    expect(currencySymbol('XYZ')).toBe('¥')
    expect(currencySymbol('USD')).toBe('$')
  })
})

describe('age buckets', () => {
  const now = 1_000_000_000

  it('buckets each range', () => {
    expect(ageOf(now, now)).toEqual({ kind: 'justNow' })
    expect(ageOf(now - 90_000, now)).toEqual({ kind: 'minutes', count: 1 })
    expect(ageOf(now - 3 * 3_600_000, now)).toEqual({ kind: 'hours', count: 3 })
    expect(ageOf(now - 2 * 86_400_000, now)).toEqual({ kind: 'days', count: 2 })
  })

  it('reads a future timestamp as just now rather than a negative age', () => {
    expect(ageOf(now + 5_000, now)).toEqual({ kind: 'justNow' })
  })
})

describe('rate parsing', () => {
  it('accepts a non-negative number and blanks', () => {
    expect(parseRate(' 4.5 ')).toBe(4.5)
    expect(parseRate('')).toBe(0)
    expect(parseRate('0')).toBe(0)
  })

  it('rejects text and negative numbers', () => {
    expect(parseRate('four')).toBeUndefined()
    expect(parseRate('-1')).toBeUndefined()
  })
})

describe('provider route discovery', () => {
  it('reads model ids out of a provider profile', () => {
    expect(modelIdsOf({ models: [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { name: 'no id' }] })).toEqual(['a', 'b'])
    expect(modelIdsOf({ models: 'none' })).toEqual([])
    expect(modelIdsOf(null)).toEqual([])
  })

  it('walks a settings path', () => {
    expect(valueAtPath({ providers: { bai: { models: [] } } }, ['providers', 'bai'])).toEqual({ models: [] })
    expect(valueAtPath({ providers: {} }, ['providers', 'bai'])).toBeUndefined()
    expect(valueAtPath(undefined, ['providers'])).toBeUndefined()
  })

  it('joins the directory with the profiles their settings hold', () => {
    const groups = providerRoutes(
      [
        { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
        { provider: 'x', displayName: 'X', settingsNs: 'llm-x', settingsPath: [] },
      ],
      [{ id: 'live-only', name: 'Live only' }],
      [
        { ns: 'llm-pi-ai', value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } } },
        { ns: 'deepseek-official', value: {} },
      ],
    )
    expect(groups).toEqual([
      {
        provider: 'bai',
        displayName: 'BAI',
        models: ['glm-5.3-flash'],
        modelsReadable: true,
        official: false,
        configured: true,
      },
      { provider: 'x', displayName: 'X', models: [], modelsReadable: false, official: false, configured: false },
      {
        provider: 'live-only',
        displayName: 'Live only',
        models: [],
        modelsReadable: false,
        official: false,
        configured: true,
      },
    ])
  })

  it('leaves a catalogue provider the user never configured out of the priced set', () => {
    const [catalogue, configured] = providerRoutes(
      [
        { provider: 'zai', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai'] },
        { provider: 'bai', displayName: 'BAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'bai'] },
      ],
      [],
      [{
        ns: 'llm-pi-ai',
        value: { providers: { bai: { models: [{ id: 'glm-5.3-flash' }] } } },
        user: { providers: { bai: { apiKeyEnv: 'BAI_API_KEY', models: [{ id: 'glm-5.3-flash' }] } } },
      }],
    )
    expect(catalogue?.configured).toBe(false)
    expect(configured?.configured).toBe(true)
  })

  it('marks the official DeepSeek route by provider id or settings namespace', () => {
    expect(providerRoutes(
      [{ provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }],
      [],
      [],
    )[0]?.official).toBe(true)
    expect(providerRoutes(
      [{ provider: 'renamed', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] }],
      [],
      [],
    )[0]?.official).toBe(true)
  })
})
