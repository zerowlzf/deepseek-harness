/**
 * The `ui-billing` settings scope: one namespace view of the shared describe
 * mirror, and the writes that keep it current.
 *
 * The mirror is the settings domain's one `settings.describe` reader; this
 * controller derives the plugin's namespace from it, publishes the snapshot the
 * pills and the Billing page render, and folds each write's answer back into
 * the mirror so every derived surface moves together.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/settings-scope
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { fillBillingSettings, NS, type SparseBillingSettings } from '../settings.ts'
import type { BillingScopeSnapshot } from './face.ts'

/**
 * The `ui-billing` namespace as one reactive snapshot.
 * @param view - the namespace view the mirror holds, or undefined when it holds none.
 * @param writable - whether the Host document the mirror describes accepts writes.
 * @returns the scope snapshot for that view, absent state fields read as `null`.
 */
export function billingScopeOf(
  view: SettingsNamespaceView | undefined,
  writable: boolean,
): BillingScopeSnapshot {
  if (view === undefined) {
    return { status: 'unavailable', value: undefined, revision: undefined, writable: false }
  }
  return {
    status: 'ready',
    value: fillBillingSettings(view.value as SparseBillingSettings),
    revision: view.revision,
    writable,
  }
}

/** The `ui-billing` settings namespace as a store over the shared describe mirror. */
export class BillingSettingsController {
  /** Scope snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<BillingScopeSnapshot> = createSnapshotStore({
    status: 'loading',
    value: undefined,
    revision: undefined,
    writable: false,
  })

  private following: (() => void) | undefined
  private disposed = false

  /**
   * @param describeFace - the shared mirror's read/fold face (descriptor and schema source).
   * @param ctx - the plugin's context, whose `remote.settings` namespace carries the writes.
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly ctx: ClientContext,
  ) {}

  /**
   * Begin following the mirror (idempotent) and reflect its current answer.
   * @returns settlement once the snapshot reflects the mirror.
   */
  async load(): Promise<void> {
    if (this.disposed) return
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * Apply path-addressed edits to the namespace, fenced by the revision the
   * mirror holds, and fold the write's answer into the mirror.
   * @param ops - the edits to apply, in order.
   * @returns settlement after the namespace commits the change.
   * @throws when the mirror holds no namespace view, or the Host refused the write.
   */
  async mutate(ops: readonly SettingsPathOpView[]): Promise<void> {
    const view = this.describeFace.getSnapshot().view?.namespaces
      .find(entry => entry.ns === NS)
    if (view === undefined) throw new Error(`the "${NS}" settings namespace is not exposed to this client`)
    // The write carries the ops as the wire face types them: a mutable list,
    // copied so the controller keeps taking its callers' arrays read-only.
    const response = await this.ctx.remote.settings.mutate(NS, [...ops], view.revision)
    if (!response.ok) throw response.error
    this.describeFace.acceptView(response.value)
  }

  /** Stop following the mirror; later publishes leave the snapshot alone. */
  dispose(): void {
    this.disposed = true
    this.following?.()
    this.following = undefined
  }

  /** Reflect the mirror's current answer into the scope snapshot. */
  private derive(): void {
    if (this.disposed) return
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.status === 'unavailable') {
      // The terminal non-loopback state: this client keeps Host persistence
      // disabled, so every billing surface hides itself exactly like an
      // unserved namespace.
      this.store.set({ status: 'unavailable', value: undefined, revision: undefined, writable: false })
      return
    }
    if (mirrored.view === undefined) return
    this.store.set(billingScopeOf(
      mirrored.view.namespaces.find(entry => entry.ns === NS),
      mirrored.view.writable,
    ))
  }
}
