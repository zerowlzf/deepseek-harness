/**
 * The plugin's injected business face, named apart from the client entry so a
 * component can type against it without importing the module that imports the
 * component: only types cross this edge, and the module graph stays acyclic.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/face
 */

import type { BillingSettings } from '../settings.ts'
import type { ProviderRouteGroup } from './routes.ts'

/** The `ui-billing` settings namespace as one reactive snapshot. */
export interface BillingScopeSnapshot {
  /**
   * `loading` until the first accepted view, `ready` while one stands, and
   * `unavailable` when the namespace is not exposed to this client or the
   * connection keeps preferences process-local (memory mode).
   */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted settings value; undefined before the first acceptance. */
  value: BillingSettings | undefined
  /** Namespace revision fencing the next write; undefined before the first Host view. */
  revision: number | undefined
  /** Whether the Host document accepts writes; memory mode never does. */
  writable: boolean
}

/** The plugin's injected business face: reactive reads, the directory loader, and the writes. */
export interface BillingInjected {
  /** Reactive sources are bound by the renderer into `use<Name>` selector hooks. */
  hooks: {
    /** The `ui-billing` namespace snapshot. */
    billing: { getSnapshot: () => BillingScopeSnapshot; subscribe: (fn: () => void) => () => void }
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
   * Write one route's rates, or remove its stored row when nothing is left.
   * @param route - the `provider/model` key to write.
   * @param peak - typed peak-window values by field name, where an unparsable field is dropped from the write.
   * @param offPeak - typed off-peak-window values by field name; all three empty clears the row's second band.
   * @returns settlement after the namespace commits the change.
   */
  saveRate: (
    route: string,
    peak: Readonly<Record<string, string>>,
    offPeak: Readonly<Record<string, string>>,
  ) => Promise<void>
  /**
   * Remove one stored rate row.
   * @param route - the `provider/model` key to clear.
   * @returns settlement after the namespace commits the change.
   */
  clearRate: (route: string) => Promise<void>
  /**
   * Ask the Host to read the published price page now rather than at the next
   * automatic read. The request is a settings write, so it settles when the
   * document commits — not when the page has been read; the namespace's
   * `officialRequest` field stays set until that read settles.
   * @returns settlement after the namespace records the request.
   */
  refreshPrices: () => Promise<void>
}
