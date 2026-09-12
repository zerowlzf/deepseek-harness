/**
 * Billing plugin, browser half: the session and turn cost pills over the
 * shipped chat surfaces, and the Billing settings page that owns the rates.
 *
 * All three surfaces read one value — the `ui-billing` settings namespace —
 * and price tokens the provider already reported. Nothing here calls a model
 * or adds a request; unmounting the plugin removes every pill and the page.
 *
 * The apply closure owns every ctx read: the bound scope reaches components as
 * a `useBilling` selector hook through the `hooks` compartment, and the provider
 * directory reaches the settings page as the `routeGroups` callback. A
 * component therefore receives plain data and callbacks, never the context.
 *
 * The settings namespace and the copy dictionary are distinct facts and are
 * named apart: a single shared identifier binds the scope to the dictionary,
 * which reads as an unregistered namespace and leaves every surface empty.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NS, parseRate, RATE_FIELDS, type BillingSettings } from '../settings.ts'
import { LOCALE_NS, en, zh, type BillingKey, type BillingTranslate } from './locales.ts'
import { providerRoutes, type ProviderRouteGroup } from './routes.ts'
import { SessionCostMeter } from './CostMeter.tsx'
import { TurnCostMeter } from './TurnCostMeter.tsx'
import { BillingSection } from './SettingsSection.tsx'

export type { BillingSectionProps } from './SettingsSection.tsx'
export type { SessionCostMeterProps } from './CostMeter.tsx'
export type { TurnCostMeterProps } from './TurnCostMeter.tsx'
export type { BillingKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Billing pill, dialog, and settings copy. */
    billing: BillingKey
  }
}

/** Required services: the slot ledger, copy dictionaries, and the settings transport. */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.llm']

/** The plugin's injected business face: reactive reads, the directory loader, and the writes. */
export interface BillingInjected {
  /** Reactive sources are bound by the renderer into `use<Name>` selector hooks. */
  hooks: {
    /** The `ui-billing` namespace snapshot. */
    billing: { getSnapshot: () => SettingsScopeSnapshot<BillingSettings>; subscribe: (fn: () => void) => () => void }
    /** The provider groups the plugin loaded. */
    billingGroups: {
      getSnapshot: () => readonly ProviderRouteGroup[]
      subscribe: (fn: () => void) => () => void
    }
  }
  /**
   * Ask the plugin to reload the provider directory.
   * @returns settlement after the load publishes, whatever it found.
   */
  routeGroups: () => Promise<void>
  /**
   * Write one provider's price fields, or remove its stored rates when the
   * fields are all empty.
   * @param route - the `provider/model` key to write.
   * @param fields - the field values as typed, where an unparsable or empty
   * field is dropped from the write.
   * @returns settlement after the namespace commits the change.
   */
  saveRate: (route: string, fields: Readonly<Record<string, string>>) => Promise<void>
  /**
   * Remove one stored rate row.
   * @param route - the `provider/model` key to clear.
   * @returns settlement after the namespace commits the change.
   */
  clearRate: (route: string) => Promise<void>
}

/**
 * Register the dictionaries, the settings page, and the two cost pills.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'ui-billing: copy dictionaries')
  const scope = ctx.settingsScope.bind<BillingSettings>({ namespace: NS })
  // The nav label is registration-time text, so it reads the bound translate
  // directly; every component takes the framework's own `t` seat instead.
  const t: BillingTranslate = ctx.locale.bind(LOCALE_NS)
  const groups = createSnapshotStore<readonly ProviderRouteGroup[]>([])

  /**
   * Read the provider directory and the settings mirror into route groups.
   *
   * Both reads belong to the apply world: the directory arrives over
   * `ctx.remote.llm`, and the mirror is the shared describe face every settings
   * surface derives from. A failed read keeps the previous answer.
   * @returns settlement after the store publishes.
   */
  const routeGroups = async (): Promise<void> => {
    const describe = ctx.settingsScope.describe()
    const [registered, directory] = await Promise.all([
      ctx.remote.llm.listProviders(),
      ctx.remote.llm.listConfigurableProviders(),
    ])
    if (!registered.ok || !directory.ok) return
    await describe.ensure()
    const view = describe.getSnapshot().view
    if (view === undefined) return
    groups.set(directory.value.length === 0 && registered.value.length === 0
      ? []
      : providerRoutes(directory.value, registered.value, view.namespaces.map(entry => ({
        ns: entry.ns,
        value: entry.value,
        ...entry.user === undefined ? {} : { user: entry.user },
      }))))
  }

  // The two signals that can move the directory, subscribed where the reads
  // live. Neither the subscription nor the plugin starts a load: the Billing
  // page asks when it opens, and a signal only refreshes a list that already has
  // an answer, so mounting this plugin issues no request until someone looks.
  ctx.effect(() => {
    const refresh = (): void => {
      if (groups.getSnapshot().length === 0) return
      void routeGroups()
    }
    const disposers = [
      ctx.remote.$on('llm/adapters-updated', refresh),
      ctx.on('connection/reset', refresh),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ui-billing: provider directory invalidations')

  /**
   * Write one route's three fields, or drop the row when every field is empty.
   * @param route - the `provider/model` key to write.
   * @param fields - typed values by field name; an empty or unparsable field is
   * left out of the write, exactly as the page's draft table leaves it.
   * @returns settlement after the namespace commits the change.
   */
  const saveRate = async (route: string, fields: Readonly<Record<string, string>>): Promise<void> => {
    const ops: SettingsPathOpView[] = []
    for (const field of RATE_FIELDS) {
      const parsed = parseRate(fields[field] ?? '')
      if (parsed === undefined) continue
      if ((fields[field] ?? '').trim() === '' && scope.getSnapshot().value?.models[route] === undefined) continue
      ops.push({ op: 'set', path: ['models', route, field], value: parsed })
    }
    await scope.mutate(ops.length === 0
      ? [{ op: 'unset', path: ['models', route] }]
      : ops)
  }

  /**
   * Remove one stored rate row.
   * @param route - the `provider/model` key to clear.
   * @returns settlement after the namespace commits the change.
   */
  const clearRate = async (route: string): Promise<void> => {
    await scope.mutate([{ op: 'unset', path: ['models', route] }])
  }

  const injected = (): BillingInjected => ({
    hooks: {
      billing: {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: listener => scope.subscribe(listener),
      },
      billingGroups: {
        getSnapshot: () => groups.getSnapshot(),
        subscribe: listener => groups.subscribe(listener),
      },
    },
    routeGroups,
    saveRate,
    clearRate,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'billing',
    // After every shipped section: the nav reads general, models, plugins,
    // agent presets, then the rates.
    order: 30,
    label: () => t('section.label'),
    locale: LOCALE_NS,
    inject: injected,
  }, BillingSection))

  // The shipped stats row owns the line these figures belong to, so the row's
  // own trailing hole is the seat: it centres them with the pills they extend.
  ctx.slots.inject('conversation.composer.stats', () => ctx.slots.register({
    name: 'conversation.composer.stats',
    id: 'billing',
    order: 0,
    locale: LOCALE_NS,
    inject: injected,
  }, SessionCostMeter))

  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    // Every completed turn elects this entry, including one interrupted before
    // any finalized text: that turn still owns its accounting and still renders
    // the row, so its cost is exactly what a reader wants there. A turn with no
    // accounting at all renders nothing. `priority` keeps the shipped
    // produced-files entry (default 0) first, so a turn with files keeps its
    // file row and the cost pill follows it.
    select: (owner: TurnTailOwnerProps) => ({ turn: owner.turn.turn }),
    priority: 1,
    locale: LOCALE_NS,
    inject: injected,
  }, TurnCostMeter))
}
