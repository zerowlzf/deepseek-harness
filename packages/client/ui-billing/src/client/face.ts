/**
 * The plugin's injected business face, named apart from the client entry so a
 * component can type against it without importing the module that imports the
 * component: only types cross this edge, and the module graph stays acyclic.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/face
 */

import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BillingSettings } from '../settings.ts'
import type { ProviderRouteGroup } from './routes.ts'

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
