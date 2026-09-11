/**
 * Money and time formatting for the billing surfaces.
 *
 * Cost values span four orders of magnitude in ordinary use: one turn is a
 * fraction of a yuan while a long session reaches tens. A fixed precision
 * renders either `¥0.00` forever or noise, so the formatter widens with the
 * magnitude and reports pennies only where they mean something.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/format
 */

/** Currency symbol used when the provider reports a code this table does not carry. */
const DEFAULT_SYMBOL = '¥'

const SYMBOLS: Readonly<Record<string, string>> = { CNY: '¥', USD: '$', EUR: '€' }

/**
 * Symbol for one currency code.
 * @param currency - ISO code the balance reported, or the configured fallback.
 * @returns the symbol this package displays it with, or the yen/yuan sign for a code the table does not carry.
 */
export function currencySymbol(currency: string): string {
  return SYMBOLS[currency] ?? DEFAULT_SYMBOL
}

function fixed(value: number, digits: number): string {
  return value.toFixed(digits)
}

/**
 * Format one amount with magnitude-adaptive precision.
 * @param amount - the amount to format.
 * @param currency - currency code selecting the symbol.
 * @returns the symbol followed by the amount, or `-` for a non-finite value.
 */
export function formatAmount(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '-'
  const symbol = currencySymbol(currency)
  const magnitude = Math.abs(amount)
  if (magnitude === 0) return `${symbol}0.00`
  // Below a yuan the leading digits are zeroes; two significant digits carry
  // the information a reader wants. Above a yuan, cents are the unit of
  // account and two decimals are both exact enough and conventional.
  if (magnitude < 0.001) return `${symbol}${fixed(amount, 6)}`
  if (magnitude < 0.01) return `${symbol}${fixed(amount, 5)}`
  if (magnitude < 0.1) return `${symbol}${fixed(amount, 4)}`
  if (magnitude < 1) return `${symbol}${fixed(amount, 3)}`
  if (magnitude < 1000) return `${symbol}${fixed(amount, 2)}`
  return `${symbol}${fixed(amount, 0)}`
}

/**
 * Format one balance, which is an account figure rather than a cost: it keeps
 * cents as soon as it is worth a cent.
 * @param amount - the balance amount.
 * @param currency - currency code selecting the symbol.
 * @returns the symbol followed by the amount, or `-` for a non-finite value.
 */
export function formatBalance(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '-'
  const symbol = currencySymbol(currency)
  const magnitude = Math.abs(amount)
  if (magnitude === 0) return `${symbol}0.00`
  if (magnitude < 0.01) return `${symbol}${fixed(amount, 4)}`
  return `${symbol}${fixed(amount, 2)}`
}

/** Relative age of one timestamp, for the balance freshness label. */
export type AgeBucket =
  | { readonly kind: 'justNow' }
  | { readonly kind: 'minutes'; readonly count: number }
  | { readonly kind: 'hours'; readonly count: number }
  | { readonly kind: 'days'; readonly count: number }

/**
 * Bucket the age of one timestamp.
 * @param at - epoch milliseconds of the fact.
 * @param now - epoch milliseconds of the current render.
 * @returns the age bucket; a future timestamp reads as `justNow`.
 */
export function ageOf(at: number, now: number): AgeBucket {
  const seconds = (now - at) / 1000
  if (seconds < 60) return { kind: 'justNow' }
  if (seconds < 3600) return { kind: 'minutes', count: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { kind: 'hours', count: Math.floor(seconds / 3600) }
  return { kind: 'days', count: Math.floor(seconds / 86_400) }
}

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
