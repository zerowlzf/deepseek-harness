// Billing settings page: the DeepSeek account balance the Host reads, then one
// card per provider the user actually configured. A card is closed by default
// and shows the models its rates apply to, the way the Models page shows a
// provider; the price fields appear behind its edit control. Rates are per
// million tokens in the account's currency, which is the unit the provider
// bills in.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_CURRENCY, ROUTE_SEPARATOR, splitRouteKey, type BillingSettings, type ModelRate } from '../settings.ts'
import { providerRoutes, type ProviderRouteGroup } from './routes.ts'
import { ageOf, formatBalance, parseRate } from './format.ts'
import { currencyOf, useScopeSnapshot } from './CostMeter.tsx'
import { IconWalletOutline16 } from './icons.tsx'
import type { BillingKey, BillingTranslate } from './locales.ts'
import css from './SettingsSection.module.css'

/** The three rate fields, in display order. */
const FIELDS = ['cacheHit', 'cacheMiss', 'output'] as const

/** One editable rate field. */
type Field = (typeof FIELDS)[number]

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
 * Read the settings describe mirror into provider groups.
 * @param ctx - the client plugin's context; its `remote.llm` namespace carries the directory.
 * @param describe - the shared settings describe face.
 * @returns provider groups, or an empty list while either read is unavailable.
 */
async function loadGroups(
  ctx: ClientContext,
  describe: {
    ensure(): Promise<void>
    getSnapshot(): {
      view: { namespaces: readonly { ns: string; value: unknown; user?: unknown }[] } | undefined
    }
  },
): Promise<ProviderRouteGroup[]> {
  const [registered, directory] = await Promise.all([
    ctx.remote.llm.listProviders(),
    ctx.remote.llm.listConfigurableProviders(),
  ])
  if (!registered.ok || !directory.ok) return []
  await describe.ensure()
  const view = describe.getSnapshot().view
  if (view === undefined) return []
  return providerRoutes(directory.value, registered.value, view.namespaces.map(entry => ({
    ns: entry.ns,
    value: entry.value,
    ...entry.user === undefined ? {} : { user: entry.user },
  })))
}

/** Props of the Billing settings section. */
export interface BillingSectionProps {
  /** The `ui-billing` namespace scope, bound by the plugin. */
  scope: SettingsScope<BillingSettings>
  /** Client plugin context, used for provider discovery and the settings mirror. */
  ctx: ClientContext
  /** Page locale seat. */
  t: BillingTranslate
}

/**
 * Render the Billing settings page.
 * @param props - namespace scope, discovery context, and locale.
 * @returns the balance card and the per-model rate rows.
 */
export function BillingSection({ scope, ctx, t }: BillingSectionProps) {
  const snapshot = useScopeSnapshot(scope)
  const [groups, setGroups] = useState<readonly ProviderRouteGroup[]>([])
  const [drafts, setDrafts] = useState<Drafts>(() => new Map())
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [failure, setFailure] = useState('')
  const [manual, setManual] = useState('')
  const [manualError, setManualError] = useState(false)
  // One provider card is open at a time: the page shows what the rates apply to
  // (the models the user configured), and the fields appear on demand.
  const [editing, setEditing] = useState<string | undefined>(undefined)
  const rates = snapshot.value?.models ?? {}
  const balance = snapshot.value?.cache ?? null

  const describe = ctx.settingsScope.describe()
  const reload = useCallback(async (): Promise<void> => {
    setGroups(await loadGroups(ctx, describe))
  }, [ctx, describe])

  useEffect(() => {
    void reload()
    const disposers = [
      ctx.remote.$on('llm/adapters-updated', () => { void reload() }),
      ctx.on('connection/reset', () => { void reload() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, [ctx, reload])

  // Every provider card the page shows: the ones the user configured (or that
  // the adapter serves without configuration), plus any provider a stored rate
  // row still names, so a route whose provider went away stays editable and
  // clearable. A catalogue row nobody configured carries nothing to price and
  // is left out.
  const cards = useMemo(() => {
    const byProvider = new Map<string, string[]>()
    for (const group of groups) {
      if (!group.configured && !Object.keys(rates).some(key =>
        key.startsWith(`${group.provider}${ROUTE_SEPARATOR}`))) continue
      const models = [...group.models]
      for (const key of Object.keys(rates)) {
        if (!key.startsWith(`${group.provider}${ROUTE_SEPARATOR}`)) continue
        const model = key.slice(group.provider.length + 1)
        if (!models.includes(model)) models.push(model)
      }
      byProvider.set(group.provider, models)
    }
    for (const key of Object.keys(rates)) {
      const route = splitRouteKey(key)
      if (route === undefined || byProvider.has(route.provider)) continue
      byProvider.set(route.provider, [route.model])
    }
    return [...byProvider]
  }, [groups, rates])

  const nameOf = (provider: string): string =>
    groups.find(group => group.provider === provider)?.displayName ?? provider

  const valueOf = (route: string, field: Field): string =>
    drafts.get(draftKey(route, field)) ?? rateText(rates[route], field)

  const save = async (route: string): Promise<void> => {
    const ops: SettingsPathOpView[] = []
    for (const field of FIELDS) {
      const raw = valueOf(route, field)
      const parsed = parseRate(raw)
      if (parsed === undefined) continue
      if (raw.trim() === '' && rates[route] === undefined) continue
      ops.push({ op: 'set', path: ['models', route, field], value: parsed })
    }
    setStatus('saving')
    setFailure('')
    try {
      if (ops.length === 0) {
        await scope.mutate([{ op: 'unset', path: ['models', route] }])
      } else {
        await scope.mutate(ops)
      }
      setDrafts((current) => {
        const next = new Map(current)
        for (const field of FIELDS) next.delete(draftKey(route, field))
        return next
      })
      setStatus('saved')
    } catch (error: unknown) {
      setStatus('error')
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }

  const clear = async (route: string): Promise<void> => {
    setStatus('saving')
    setFailure('')
    try {
      await scope.mutate([{ op: 'unset', path: ['models', route] }])
      setDrafts((current) => {
        const next = new Map(current)
        for (const field of FIELDS) next.delete(draftKey(route, field))
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
    // Below the open provider, the typed route is already in the draft table;
    // its row renders as soon as its price is saved.
    const provider = typed.slice(0, at)
    if (!groups.some(group => group.provider === provider)) {
      setGroups(current => [...current, {
        provider,
        displayName: provider,
        models: [typed.slice(at + 1)],
        modelsReadable: true,
        official: false,
        configured: true,
      }])
    }
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
          <span>{currencyOf(balance, snapshot.value?.currency ?? DEFAULT_CURRENCY)}</span>
        </div>
        {snapshot.value?.cacheError != null && (
          <div className={css.warn}>{t('section.balanceError', { message: snapshot.value.cacheError })}</div>
        )}
      </section>

      {!snapshot.writable && <div className={css.warn}>{t('section.writable')}</div>}

      <section className={css.rates} data-billing-rates>
        <h3 className={css.sectionTitle}>{t('section.providers')}</h3>
        {cards.length === 0 && <p className={css.empty}>{t('section.providersEmpty')}</p>}
        {cards.map(([provider, models]) => {
          const group = groups.find(candidate => candidate.provider === provider)
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
                          {FIELDS.map(field => (
                            <label key={field} className={css.field}>
                              <span className={css.fieldLabel}>{t(FIELD_KEYS[field])}</span>
                              <input
                                className={css.input}
                                type="text"
                                inputMode="decimal"
                                value={valueOf(route, field)}
                                placeholder="0"
                                disabled={!snapshot.writable}
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
                              disabled={!snapshot.writable || status === 'saving'}
                              onClick={() => { void clear(route) }}
                            >
                              {t('section.clear')}
                            </Button>
                            <Button
                              size="sm"
                              variant="primary"
                              disabled={!snapshot.writable || status === 'saving'}
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
