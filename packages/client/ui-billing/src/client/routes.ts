/**
 * Route discovery for the Billing settings page.
 *
 * The page lists the models the user already configured, so it reads the same
 * two facts the Models page joins: the registered provider routes (with their
 * settings address) and the profile value stored at that address. Model ids
 * come out of that profile rather than out of a new Host API, because the
 * profile is what the adapter itself resolves.
 *
 * @module @deepseek-ai/dsh-client-ui-billing/routes
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { splitRouteKey } from '../settings.ts'

/** One provider row the page renders. */
export interface ProviderRouteGroup {
  /** Provider route id (`deepseek-official`, `bai`, …). */
  readonly provider: string
  /** Display name the provider registered. */
  readonly displayName: string
  /** Model ids read from the provider's own settings profile. */
  readonly models: readonly string[]
  /** Whether the profile exposes models at all; `false` asks the user to add routes by hand. */
  readonly modelsReadable: boolean
  /** Whether this route is the official DeepSeek provider. */
  readonly official: boolean
}

/** Provider route id of the shipped DeepSeek adapter. */
export const OFFICIAL_PROVIDER = 'deepseek-official'

/** Settings namespace the shipped DeepSeek adapter owns. */
const OFFICIAL_SETTINGS_NS = 'llm-deepseek'

/**
 * Read the model ids out of one provider profile value.
 *
 * A provider profile declares its models as an array of objects carrying an
 * `id`; this reads exactly that field and ignores every other model property.
 * @param profile - the value stored at the provider's settings address.
 * @returns model ids in declaration order; an empty list when the profile shape carries none.
 */
export function modelIdsOf(profile: unknown): string[] {
  if (typeof profile !== 'object' || profile === null) return []
  const models = (profile as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  const ids: string[] = []
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue
    const id = (entry as Record<string, unknown>)['id']
    if (typeof id !== 'string' || id.length === 0) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Walk a settings value to one path.
 * @param value - the namespace's resolved value.
 * @param path - settings path from the provider directory entry.
 * @returns the value at that path, or undefined when any segment is absent.
 */
export function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** One provider route as the provider directory reports it. */
interface DirectoryEntry {
  readonly provider: string
  readonly displayName: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}

/** One settings namespace as the describe mirror reports it. */
interface NamespaceView {
  readonly ns: string
  readonly value: unknown
}

/**
 * Join the provider directory with the settings values their profiles live in.
 * @param directory - `llm/listConfigurableProviders()` rows.
 * @param registered - `llm/listProviders()` rows (name only; used when undirected).
 * @param namespaces - the settings describe mirror's namespace views.
 * @returns one group per provider, directory order first.
 */
export function providerRoutes(
  directory: readonly DirectoryEntry[],
  registered: readonly { readonly id: string; readonly name: string }[],
  namespaces: readonly NamespaceView[],
): ProviderRouteGroup[] {
  const values = new Map(namespaces.map(view => [view.ns, view.value]))
  const groups: ProviderRouteGroup[] = []
  const seen = new Set<string>()
  for (const entry of directory) {
    seen.add(entry.provider)
    const profile = values.has(entry.settingsNs)
      ? valueAtPath(values.get(entry.settingsNs), entry.settingsPath)
      : undefined
    const models = modelIdsOf(profile)
    groups.push({
      provider: entry.provider,
      displayName: entry.displayName,
      models,
      modelsReadable: profile !== undefined,
      official: entry.provider === OFFICIAL_PROVIDER || entry.settingsNs === OFFICIAL_SETTINGS_NS,
    })
  }
  for (const provider of registered) {
    if (seen.has(provider.id)) continue
    groups.push({
      provider: provider.id,
      displayName: provider.name,
      models: [],
      modelsReadable: false,
      official: provider.id === OFFICIAL_PROVIDER,
    })
  }
  return groups
}

/**
 * Route keys the page must show even though no configured model produced them:
 * every stored rate row, so a route whose provider disappeared stays editable
 * and clearable.
 * @param stored - the namespace's rate-row keys.
 * @param groups - discovered provider groups.
 * @returns keys to append to their group (or to a group with no discovered models).
 */
export function orphanRoutes(
  stored: readonly string[],
  groups: readonly ProviderRouteGroup[],
): string[] {
  const discovered = new Set<string>()
  for (const group of groups) {
    for (const model of group.models) discovered.add(`${group.provider}/${model}`)
  }
  return stored.filter(key => !discovered.has(key) && splitRouteKey(key) !== undefined)
}
