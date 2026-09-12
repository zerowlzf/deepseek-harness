/**
 * Billing plugin, browser half: the session and turn cost pills over the
 * shipped chat surfaces, and the Billing settings page that owns the rates.
 *
 * All three surfaces read one value — the `ui-billing` settings namespace —
 * and price tokens the provider already reported. Nothing here calls a model
 * or adds a request; unmounting the plugin removes every pill and the page.
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
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import { NS, type BillingSettings } from '../settings.ts'
import { LOCALE_NS, en, zh, type BillingKey, type BillingTranslate } from './locales.ts'
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

/** The plugin's injected business face, closed over the bound namespace scope. */
interface BillingInjected {
  scope: SettingsScope<BillingSettings>
  ctx: ClientContext
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
  const injected = (): BillingInjected => ({ scope, ctx })

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
