// Turn-cost pill inside a completed turn's action row: the stat pill beside
// the shipped Turn-usage and Turn-time triggers, labelled with what the turn
// cost and click-opening the per-route breakdown.
//
// The turn's token accounting comes from the shipped turn-tail payload, which
// is the same evidence the Turn-usage dialog shows; the loaded window supplies
// each attempt's route, so a turn that switched models is priced per attempt.

import { Fragment } from 'react'
import { createPortal } from 'react-dom'
import type {
  ChatConversationViewNode, TurnTailChatData, TurnTailOwnerProps, UseChat,
} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_CURRENCY, type BillingSettings, type ModelRate } from '../settings.ts'
import type { BillingTranslate } from './locales.ts'
import { turnCost, turnRouteUsage, type TurnBuckets, type TurnRouteUsage } from './cost.ts'
import { formatAmount } from './format.ts'
import { IconCoinOutline16 } from './icons.tsx'
import { currencyOf, useScopeSnapshot } from './CostMeter.tsx'
import { MEASURE_STYLE, useStatDialog } from './stat-dialog.ts'
import css from './TurnCostMeter.module.css'
import dialogCss from './stat-dialog.module.css'

/** Props of the turn-tail billing pill. */
export interface TurnCostMeterProps {
  /**
   * Owner currency of the completed-turn extension chain. Optional because the
   * slot ledger resolves this key's owner share through `OwnerOf`, which is
   * `object` in some compilations; the component treats its absence as "no
   * turn to price" instead of relying on the share being non-null.
   */
  owner?: TurnTailOwnerProps | undefined
  /** Selector over the current Chat snapshot. */
  useChat: UseChat
  /** The `ui-billing` namespace scope, bound by the plugin. */
  scope: SettingsScope<BillingSettings>
  /** Pill locale seat. */
  t: BillingTranslate
}

/** One attempt's billed buckets under the route that produced it. */
export interface AttemptUsage {
  readonly route: string
  readonly buckets: TurnBuckets
}

/** Read one finite number out of a provider-reported usage payload. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Read the loaded attempts of one turn, route by route.
 * @param nodes - the loaded Chat nodes.
 * @param turn - the turn to collect.
 * @returns one entry per assistant attempt that reported both usage and a route.
 */
export function attemptsOf(nodes: readonly ChatConversationViewNode[], turn: number): AttemptUsage[] {
  const attempts: AttemptUsage[] = []
  for (const node of nodes) {
    if (node.kind !== 'assistant') continue
    const data = node.data as {
      readonly turn?: unknown
      readonly finalNode?: {
        readonly usage?: unknown
        readonly provenance?: { readonly provider?: unknown; readonly model?: unknown }
      }
    }
    if (data.turn !== turn) continue
    const finalNode = data.finalNode
    const usage = finalNode?.usage
    if (typeof usage !== 'object' || usage === null) continue
    const provider = finalNode?.provenance?.provider
    const model = finalNode?.provenance?.model
    if (typeof provider !== 'string' || typeof model !== 'string') continue
    attempts.push({
      route: `${provider}/${model}`,
      buckets: {
        uncachedInputTokens: count(Reflect.get(usage, 'inputTokens')),
        outputTokens: count(Reflect.get(usage, 'outputTokens')),
        cacheReadTokens: count(Reflect.get(usage, 'cacheReadTokens')),
        cacheWriteTokens: count(Reflect.get(usage, 'cacheWriteTokens')),
      },
    })
  }
  return attempts
}

/** Price one already-resolved route row. */
function rowCost(row: TurnRouteUsage, rates: NonNullable<BillingSettings['models']>): number {
  return turnCost([row], rates).total
}

/** One route's configured rate summary for the dialog's footnote. */
function rateText(route: string, rate: ModelRate | undefined, t: TurnCostMeterProps['t']): string {
  if (rate === undefined) return `${route}: ${t('pill.dialog.unpriced')}`
  return `${route}: ${[rate.cacheHit, rate.cacheMiss, rate.output].map(value => String(value)).join(' / ')}`
}

/**
 * Render the turn-cost pill.
 * @param props - closing turn, Chat selector, namespace scope, and locale.
 * @returns the pill and its dialog, or null while the turn carries no accounting.
 */
export function TurnCostMeter({ owner, useChat, scope, t }: TurnCostMeterProps) {
  // The node store, not the legacy compatibility slice: the turn-tail payload
  // lives only in the materialized Chat nodes.
  const nodes = useChat(snapshot => snapshot.nodes.values())
  const snapshot = useScopeSnapshot(scope)
  const seat = useStatDialog()
  const turn = owner?.turn.turn
  if (turn === undefined) return null
  let usage: TurnTailChatData['tokenUsage']
  for (const node of nodes) {
    if (node.kind !== 'turn-tail') continue
    const data = node.data as Partial<TurnTailChatData>
    if (data.turn !== turn) continue
    usage = data.tokenUsage
    break
  }
  if (usage === undefined) return null

  const rates = snapshot.value?.models ?? {}
  const attempts = attemptsOf(nodes, turn)
  const rows = turnRouteUsage(usage, attempts)
  const cost = turnCost(rows, rates)
  const currency = currencyOf(snapshot.value?.cache ?? null, snapshot.value?.currency ?? DEFAULT_CURRENCY)
  const priced = cost.priced.length > 0
  const label = priced
    ? t('turn.cost', { amount: formatAmount(cost.total, currency) })
    : t('turn.costUnknown')

  return (
    <span ref={seat.rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={seat.open}
        aria-label={label}
        onClick={() => { seat.setOpen(!seat.open) }}
      >
        <IconCoinOutline16 />
        <span className={css.label}>{label}</span>
      </button>
      {seat.open && createPortal(
        <div
          ref={seat.panelRef}
          className={dialogCss.panel}
          role="dialog"
          aria-label={t('turn.title')}
          style={seat.pos ?? MEASURE_STYLE}
        >
          <div className={dialogCss.title}>
            <span className={dialogCss.titleLabel}>
              <IconCoinOutline16 />
              {t('turn.title')}
            </span>
            <span className={dialogCss.titleValue}>
              {priced ? formatAmount(cost.total, currency) : t('value.unavailable')}
            </span>
          </div>
          <div className={dialogCss.titleRule} aria-hidden />
          <dl className={dialogCss.details} data-billing-turn-routes>
            {rows.map(row => (
              <Fragment key={row.route}>
                <dt className={dialogCss.route}>{row.route}</dt>
                <dd>
                  {rates[row.route] === undefined
                    ? t('pill.dialog.unpriced')
                    : formatAmount(rowCost(row, rates), currency)}
                </dd>
              </Fragment>
            ))}
          </dl>
          {rows.length > 0 && (
            <div className={dialogCss.note}>
              {rows.map(row => rateText(row.route, rates[row.route], t)).join(' · ')}
            </div>
          )}
          {cost.unpriced.length > 0 && <div className={dialogCss.note}>{t('turn.unpriced')}</div>}
        </div>,
        document.body,
      )}
    </span>
  )
}
