/**
 * DeepSeek account-balance reads for the Host half.
 *
 * The plugin owns this call rather than the LLM adapter because the balance is
 * an account fact, not a route fact: the page shows it while the session runs
 * on any provider. One read resolves the credential per call, sends the single
 * documented request, and reports either the balance or a message the settings
 * page can display.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/account
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { BalanceSnapshot } from './settings.ts'

/** Official DeepSeek API base; the account endpoints hang off it directly. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Credential reference resolved when config names none. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** Result of one balance read: the newest snapshot, or why it could not be read. */
export type BalanceRead =
  | { readonly ok: true; readonly balance: BalanceSnapshot }
  | { readonly ok: false; readonly error: string }

/** Everything one read needs besides the context. */
export interface BalanceReadRequest {
  /** Endpoint base; the `/user/balance` path is appended. */
  readonly baseURL: string
  /** Credential reference for the API key. */
  readonly apiKeyEnv: string
  /** Currency to report when the account carries several. */
  readonly currency: string
  /** Whole-request deadline in milliseconds. */
  readonly timeoutMs: number
}

interface BalanceInfo {
  readonly currency: string
  readonly totalBalance: number
}

/**
 * Narrow one `balance_infos` entry.
 * @param value - untrusted array element.
 * @returns the currency and amount, or undefined when either is missing.
 */
function balanceInfo(value: unknown): BalanceInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const currency = entry['currency']
  const total = entry['total_balance']
  if (typeof currency !== 'string' || currency.length === 0) return undefined
  if (typeof total !== 'string') return undefined
  const amount = Number.parseFloat(total)
  if (!Number.isFinite(amount)) return undefined
  return { currency, totalBalance: amount }
}

/**
 * Pick the entry to display: the configured currency when the account carries
 * it, otherwise the first one the provider listed.
 * @param infos - every parsed balance entry.
 * @param currency - preferred currency code.
 * @returns the chosen entry.
 */
function preferred(infos: readonly BalanceInfo[], currency: string): BalanceInfo | undefined {
  return infos.find(info => info.currency === currency) ?? infos[0]
}

/**
 * Read one DeepSeek account balance.
 * @param ctx - owning plugin context, used only to reach the credential seam.
 * @param request - endpoint, credential reference, currency preference, and deadline.
 * @returns the newest snapshot or a display-ready failure message.
 */
export async function readBalance(ctx: Context, request: BalanceReadRequest): Promise<BalanceRead> {
  const credentials = ctx.get('credentials')
  const resolved = credentials === undefined
    ? undefined
    // The reference is the operator's own configuration value, so it is taken
    // as written: the seam refuses a malformed one through its own lookup.
    : await credentials.resolve(request.apiKeyEnv as CredentialRef)
  // The environment is the fallback only where no store serves the reference;
  // the plugin's `credentials` injection keeps that store initialized before
  // the first read, so this arm covers a composition that mounts none.
  const apiKey = resolved?.value ?? process.env[request.apiKeyEnv]
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, error: `no API key: store ${request.apiKeyEnv} in the credentials store or the environment` }
  }

  const url = `${request.baseURL.replace(/\/+$/, '')}/user/balance`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(request.timeoutMs),
    })
  } catch (error: unknown) {
    return { ok: false, error: `balance request failed: ${messageOf(error)}` }
  }
  if (!response.ok) {
    return { ok: false, error: `balance request failed: HTTP ${String(response.status)}` }
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error: unknown) {
    return { ok: false, error: `balance response was not JSON: ${messageOf(error)}` }
  }
  if (typeof payload !== 'object' || payload === null) {
    return { ok: false, error: 'balance response was not an object' }
  }
  const raw = (payload as Record<string, unknown>)['balance_infos']
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'balance response carried no balance_infos array' }
  }
  const infos = raw.map(balanceInfo).filter((info): info is BalanceInfo => info !== undefined)
  const chosen = preferred(infos, request.currency)
  if (chosen === undefined) {
    return { ok: false, error: 'balance response carried no usable amount' }
  }
  return {
    ok: true,
    balance: {
      total: chosen.totalBalance,
      currency: chosen.currency,
      available: (payload as Record<string, unknown>)['is_available'] !== false,
      at: Date.now(),
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
