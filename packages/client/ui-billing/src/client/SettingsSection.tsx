// Billing settings page: the DeepSeek account balance the Host reads, then one
// card per provider the user actually configured. A card is closed by default
// and shows the models its rates apply to, the way the Models page shows a
// provider; the price fields appear behind its edit control. Rates are per
// million tokens in the account's currency, which is the unit the provider
// bills in.

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  DEFAULT_CURRENCY, RATE_FIELDS, ROUTE_SEPARATOR, splitRouteKey, type BillingSettings, type ModelRate, type RateField,
} from '../settings.ts'
import type { ProviderRouteGroup } from './routes.ts'
import { ageOf, formatBalance } from './format.ts'
import { currencyOf } from './CostMeter.tsx'
import { IconWalletOutline16 } from './icons.tsx'
import type { BillingKey, BillingTranslate } from './locales.ts'
import css from './SettingsSection.module.css'

/** One editable rate field. */
type Field = RateField

/** Dictionary key of one field's label. */
const FIELD_KEYS: Readonly<Record<Field, BillingKey>> = {
  cacheHit: 'section.rateHit',
  cacheMiss: 'section.rateMiss',
  output: 'section.rateOutput',
}

/** Draft text keyed `provider/model\u0000field`. */
type Drafts = ReadonlyMap<string, string>

/** Compose the draft key for one field. */
function draftKey(route: string, field: Field): string {
  return `${route}\u0000${field}`
}

/** The configured value of one field, as display text. */
function rateText(rate: ModelRate | undefined, field: Field): string {
  if (rate === undefined) return ''
  const value = rate[field]
  return value === 0 ? '0' : String(value)
}

/**
 * Props of the Billing settings section.
 *
 * Every ctx read belongs to the plugin's apply closure: the namespace arrives as
 * a `useBilling` selector hook and the provider directory as two plain members —
 * `routeGroups` asks for a load, `useBillingGroups` observes the answer, and the
 * invalidations that trigger a refresh are subscribed where they belong.
 */
export interface BillingSectionProps {
  /**
   * Selector hook over the `ui-billing` namespace snapshot, bound by the
   * renderer from the source the plugin supplies.
   */
  useBilling: SnapshotSelectorHook<SettingsScopeSnapshot<BillingSettings>>
  /**
   * Selector hook over the provider groups the plugin loaded, joined with the
   * profiles their settings hold.
   */
  useBillingGroups: SnapshotSelectorHook<readonly ProviderRouteGroup[]>
  /** Page locale seat. */
  t: BillingTranslate
  /**
   * Write one route's three price fields, or drop the row when every field is
   * empty.
   */
  saveRate: (route: string, fields: Readonly<Record<string, string>>) => Promise<void>
  /** Remove one stored rate row. */
  clearRate: (route: string) => Promise<void>
  /** Ask the plugin for one directory load. */
  routeGroups: () => Promise<void>
}

/**
 * Render the Billing settings page.
 * @param props - namespace snapshot hook, group hook, locale, the two writes, and the loader.
 * @returns the balance card and one card per configured provider.
 */
export function BillingSection({
  useBilling, useBillingGroups, t, saveRate, clearRate, routeGroups,
}: BillingSectionProps) {
  const settings = useBilling(snapshot => snapshot.value)
  const [drafts, setDrafts] = useState<Drafts>(() => new Map())
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [failure, setFailure] = useState('')
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState(false)
  // One provider card is open at a time: the page shows what the rates apply to
  // (the models the user configured), and the fields appear on demand.
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const writable = useBilling(snapshot => snapshot.writable)
  const rates = settings?.models ?? {}
  const balance = settings?.cache ?? null
  const loaded = useBillingGroups(groups => groups)
  // Routes typed on this page that no directory declares and no stored row
  // covers yet, by provider. They keep their card (and their row) open until a
  // save turns them into stored rates.
  const [drafted, setDrafted] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map())

  // The plugin owns the reads and the invalidations that refresh them; this
  // effect only asks for one load, so opening the page never waits on a
  // directory read the plugin already started at mount.
  useEffect(() => { void routeGroups() }, [routeGroups])

  // Every provider card the page shows: the ones the user configured (or that
  // the adapter serves without configuration), plus any provider a stored rate
  // row or a route typed here names, so a route whose provider went away stays
  // editable and clearable. A catalogue row nobody configured carries nothing to
  // price and is left out. A configured provider with no readable model list
  // still gets its card — that is where its routes are added by hand.
  const cards = useMemo(() => {
    const storedRoutes = Object.keys(rates)
    const byProvider = new Map<string, string[]>()
    for (const group of loaded) {
      const covered = storedRoutes.filter(key =>
        key.startsWith(`${group.provider}${ROUTE_SEPARATOR}`))
      const typed = drafted.get(group.provider) ?? []
      if (!group.configured && covered.length === 0 && typed.length === 0) continue
      const models = [...group.models, ...typed]
      for (const key of covered) {
        const model = key.slice(group.provider.length + 1)
        if (!models.includes(model)) models.push(model)
      }
      byProvider.set(group.provider, models)
    }
    for (const [provider, models] of drafted) {
      if (byProvider.has(provider)) continue
      byProvider.set(provider, [...models])
    }
    for (const key of storedRoutes) {
      const route = splitRouteKey(key)
      if (route === undefined || byProvider.has(route.provider)) continue
      byProvider.set(route.provider, [route.model])
    }
    return [...byProvider]
  }, [loaded, drafted, rates])

  const nameOf = (provider: string): string =>
    loaded.find(group => group.provider === provider)?.displayName ?? provider

  /** Providers this page shows, in card order: the directory's, then typed ones. */
  const groupOf = (provider: string): ProviderRouteGroup | undefined =>
    loaded.find(group => group.provider === provider)
    ?? (drafted.has(provider)
      ? { provider, displayName: provider, models: [], modelsReadable: true, official: false, configured: true }
      : undefined)

  const valueOf = (route: string, field: Field): string =>
    drafts.get(draftKey(route, field)) ?? rateText(rates[route], field)

  /** Write one row through the plugin, then settle the row's own draft state. */
  const save = async (route: string): Promise<void> => {
    setStatus('saving')
    setFailure('')
    const typed: Record<string, string> = {}
    for (const field of RATE_FIELDS) typed[field] = valueOf(route, field)
    try {
      await saveRate(route, typed)
      setDrafts((current) => {
        const next = new Map(current)
        for (const field of RATE_FIELDS) next.delete(draftKey(route, field))
        return next
      })
      setStatus('saved')
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  /** Remove one row through the plugin, then settle the row's own draft state. */
  const clear = async (route: string): Promise<void> => {
    setStatus('saving')
    setFailure('')
    try {
      await clearRate(route)
      setDrafts((current) => {
        const next = new Map(current)
        for (const field of RATE_FIELDS) next.delete(draftKey(route, field))
        return next
      })
      setStatus('saved')
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const addManual = (): void => {
    const typed = manual.trim()
    const at = typed.indexOf(ROUTE_SEPARATOR)
    if (at <= 0 || at === typed.length - 1) {
      setManualError(true)
      return
    }
    setManualError(false)
    setManual('')
    // The typed route joins the page's own model list for the provider it names,
    // so its row exists to be priced before anything is stored; the card then
    // stays while its price is unsaved.
    const provider = typed.slice(0, at)
    const model = typed.slice(at + 1)
    setDrafted((current) => {
      const models = current.get(provider) ?? []
      if (models.includes(model)) return current
      const next = new Map(current)
      next.set(provider, [...models, model])
      return next
    })
    setEditing(provider)
  }

  return (
    <div className={css.page}>
      <p className={css.intro}>{t('section.intro')}</p>
      <section className={css.card} data-billing-balance-card>
        <header className={css.cardHead}>
          <span className={css.cardTitle}>
            <IconWalletOutline16 />
            {t('section.balanceTitle')}
          </span>
          <span className={css.cardValue}>
            {balance === null
              ? t('section.balanceUnavailable')
              : formatBalance(balance.total, balance.currency)}
          </span>
        </header>
        <div className={css.cardMeta}>
          {balance !== null && (
            <span>{t('section.balanceAt', { time: freshness(balance.at, t) })}</span>
          )}
          {balance !== null && !balance.available && (
            <span className={css.warn}>{t('pill.dialog.availableNo')}</span>
          )}
          <span>{currencyOf(balance, settings?.currency ?? DEFAULT_CURRENCY)}</span>
        </div>
        {settings?.cacheError != null && (
          <div className={css.warn}>{t('section.balanceError', { message: settings.cacheError })}</div>
        )}
      </section>

      {!writable && <div className={css.warn}>{t('section.writable')}</div>}

      <section className={css.rates} data-billing-rates>
        <h3 className={css.sectionTitle}>{t('section.providers')}</h3>
        {cards.length === 0 && <p className={css.empty}>{t('section.providersEmpty')}</p>}
        {cards.map(([provider, models]) => {
          const group = groupOf(provider)
          const open = editing === provider
          const priced = models.filter(model => rates[`${provider}${ROUTE_SEPARATOR}${model}`] !== undefined).length
          return (
            <div key={provider} className={css.card}>
              <header className={css.cardHead}>
                <span className={css.cardTitle}>
                  {group === undefined ? provider : nameOf(provider)}
                  {group?.official === true && <span className={css.badge}>{t('section.officialBadge')}</span>}
                  {/* The summary is what the closed card carries: which models
                      the rates apply to, and how many of them are priced. */}
                  <span className={css.cardMeta}>
                    {group !== undefined && !group.modelsReadable
                      ? t('section.providerPathUnknown')
                      : t('section.modelCount', { count: models.length })}
                    {priced > 0 && <span className={css.pricedBadge}>{t('section.pricedCount', { count: priced })}</span>}
                  </span>
                </span>
                <span className={css.actions}>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={open}
                    aria-label={t(open ? 'section.collapseProvider' : 'section.editProvider', { provider })}
                    onClick={() => { setEditing(open ? undefined : provider) }}
                  >
                    {t(open ? 'section.collapse' : 'section.edit')}
                  </Button>
                </span>
              </header>
              {open && (
                <div className={css.models} data-billing-provider-models={provider}>
                  {models.map((model) => {
                    const route = `${provider}${ROUTE_SEPARATOR}${model}`
                    return (
                      <div key={route} className={css.row} data-billing-rate-row={route}>
                        <span className={css.modelName} title={model}>{model}</span>
                        <div className={css.fields}>
                          {RATE_FIELDS.map(field => (
                            <label key={field} className={css.field}>
                              <span className={css.fieldLabel}>{t(FIELD_KEYS[field])}</span>
                              <input
                                className={css.input}
                                type="text"
                                inputMode="decimal"
                                value={valueOf(route, field)}
                                placeholder="0"
                                disabled={!writable}
                                aria-label={`${route} ${t(FIELD_KEYS[field])}`}
                                onChange={(event) => {
                                  const text = event.currentTarget.value
                                  setDrafts((current) => {
                                    const next = new Map(current)
                                    next.set(draftKey(route, field), text)
                                    return next
                                  })
                                }}
                              />
                            </label>
                          ))}
                          <div className={css.actions}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!writable || status === 'saving'}
                              onClick={() => { void clear(route) }}
                            >
                              {t('section.clear')}
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!writable || status === 'saving'}
                              onClick={() => { void save(route) }}
                            >
                              {status === 'saving' ? t('section.saving') : t('section.save')}
                            </Button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {models.length === 0 && <p className={css.empty}>{t('section.modelsEmpty')}</p>}
                  <div className={css.addRow}>
                    <input
                      className={css.input}
                      type="text"
                      value={manual}
                      placeholder={t('section.addPlaceholder')}
                      aria-label={t('section.addRouteTo', { provider })}
                      onChange={(event) => { setManual(event.currentTarget.value) }}
                      onKeyDown={(event) => { if (event.key === 'Enter') addManual() }}
                    />
                    <Button size="sm" variant="outline" onClick={addManual}>{t('section.add')}</Button>
                  </div>
                  {manualError && <div className={css.warn}>{t('section.invalidRoute')}</div>}
                </div>
              )}
            </div>
          )
        })}
        {/* The page's own entry point for a route no directory declares: it
            opens the provider it names, whose card then holds the row. */}
        <div className={css.card}>
          <header className={css.cardHead}>
            <span className={css.cardTitle}>{t('section.addRoute')}</span>
          </header>
          <div className={css.addRow}>
            <input
              className={css.input}
              type="text"
              value={manual}
              placeholder={t('section.addPlaceholder')}
              aria-label={t('section.addRoute')}
              onChange={(event) => { setManual(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter') addManual() }}
            />
            <Button size="sm" variant="outline" onClick={addManual}>{t('section.add')}</Button>
          </div>
          {manualError && <div className={css.warn}>{t('section.invalidRoute')}</div>}
        </div>
      </section>

      {status === 'error' && <div className={css.warn}>{t('section.writeFailed', { message: failure })}</div>}
      {status === 'saved' && <div className={css.note}>{t('section.saved')}</div>}
    </div>
  )
}

/** Relative freshness of the Host-read balance. */
function freshness(at: number, t: BillingSectionProps['t']): string {
  const age = ageOf(at, Date.now())
  switch (age.kind) {
    case 'justNow': return t('value.justNow')
    case 'minutes': return t('value.minutesAgo', { count: age.count })
    case 'hours': return t('value.hoursAgo', { count: age.count })
    case 'days': return t('value.daysAgo', { count: age.count })
  }
}
