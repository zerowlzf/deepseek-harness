# Agent Note: Web billing display over user-owned model rates

Status: implemented

English | [中文](2026-09-13-web-billing-display-over-user-owned-rates.zh.md)

## Problem

The Web GUI reports what a session consumed but not what it cost. The token pills under the composer and the Turn-usage dialog state turns, steps, cache-hit share, and token buckets, all of which the providers reported; nothing turns those buckets into money, and the DeepSeek account balance the same providers expose has no surface at all.

Two facts make that a plugin rather than a loop change. Pricing is user-owned configuration: a route the harness knows nothing about — a gateway, a self-hosted server, a reseller — is priced only by what its operator types. And a session mixes routes: the same conversation runs on the official DeepSeek provider and on any other configured provider, so a single session total has to price each stretch under the route that billed it rather than at one blended rate.

## Decision

`@deepseek-ai/dsh-client-ui-billing` is one dual-face package: a Host half that owns the `ui-billing` settings namespace and keeps one DeepSeek account balance cached in it, and a browser half that renders three surfaces over that value.

### The namespace is the whole contract

`ui-billing` holds `models` (rate rows keyed `provider/model`, each with per-million-token `cacheHit`, `cacheMiss`, and `output` rates), `currency` (the code every cost is displayed with), and two Host-owned fields: `cache`, the newest balance the Host could read, and `cacheError`, why the newest read failed. Rates are written through the ordinary settings Remote; the balance is written by the Host through its own scope handle. Both planes therefore read one value and neither needs a Remote of its own.

`Currency` is configuration rather than a constant because the DeepSeek endpoint reports whatever currency the account carries and can report several; the page prices and labels in the configured one, and the Host read prefers it when the account offers a choice. A deployment that bills in another currency changes one settings field instead of a code constant.

### Two folds, because the surfaces have different evidence

The session total accumulates the `tokenUsage` projection: it is a running total over the whole durable log, so each observed growth is exactly what one route was billed, and recording one stretch per growth prices a mid-session model switch correctly while retaining no per-route history. Editing a rate reprices every stretch, because the fold keeps buckets rather than money.

The per-turn row starts from the durable turn-tail accounting — the same number the shipped Turn-usage dialog shows — and splits it across the routes read from the loaded attempts. A retried attempt makes the aggregate larger than the surviving samples; that remainder is charged at the last route's rate, which keeps the priced total equal to the tokens the provider reported even when the split is approximate.

### The Host read is the only request

Nothing here issues a model request or appends a session event. The Host resolves the API key per read through the credentials seam, calls `GET /user/balance` once, and writes the answer back; the refresh chain re-arms through the timer service and stops with the plugin fiber. A failed read keeps the previous snapshot beside its reason, so a stale amount stays legible as stale. The key is taken as the operator's own configuration value; a malformed reference is the seam's refusal to make, not this package's. The seam is a required injection rather than an optional read, because a first read that starts before the credential document is loaded reports a missing key as though the operator had stored none; the process environment stays the fallback for a composition that mounts no store.

### Registration

Three surfaces, each restored on unload: `settings.section` (the Billing page), `conversation.composer.stats` (the session-cost and balance pills), and the `conversation.chat.turnTail` chain (the per-turn cost pill, at a lower chain priority than the shipped produced-files entry so a turn with files keeps its file row).

The composer figures belong to a line ui-chat already owns, so ui-chat declares the hole and its own stats row renders it: `conversation.composer.stats` is a session-scope `list` child of the `conversation.composer.dock` row, the row draws its divider only while the hole has an occupant, and the rendered children take the row's own flex gap. An earlier arrangement — a second dock row pulled up by the row's height and offset so its content began after the shipped pills — could only guess where a centred group of changing width would end, and drew through it when the guess was wrong.

The per-turn pill hangs off the turn's action strip, which now renders for a turn interrupted before any finalized text. That arm previously returned before the strip existed, so an interrupted turn showed neither the shipped usage figures nor any contribution beside them; every turn of a session where the user interrupts mid-run therefore showed no cost at all. A turn carrying nothing to show — no closing message, no contribution, no accounting, and later evidence in its own turn — still renders nothing.

The turn's price prefers the durable turn-tail accounting (per-route, from the loaded attempts) and falls back to the session projection under the newest known route, which is what prices a turn whose assistant rows have left the loaded window. `turnRouteUsage` reads the two routes the accounting itself names when no attempt survived, and states the aggregate under each rather than inventing a split.

The settings page follows the shipped Models page: one card per provider the user configured, or that a stored rate row still names, with the provider's models behind that card's own edit control. Whether a provider is configured comes from the user layer of its settings namespace — the profile the Models page itself writes — so a catalogue entry nobody configured no longer contributes a card full of zero-priced rows.

The apply closure owns every ctx read. Components take a `useBilling` selector hook over the namespace snapshot and a `useBillingGroups` hook over the loaded groups — both bound by the renderer from bare sources in the `hooks` compartment — plus plain `routeGroups`, `saveRate`, and `clearRate` callbacks. The directory's invalidations are subscribed in the plugin, and nothing loads until the page asks, so mounting the plugin issues no request at all.

A chain entry receives the owner's currency spread flat onto its props: the renderer hands a component `{...ownerProps, matched}`, so the per-turn pill reads `turn` directly the way the shipped produced-files entry reads `openFile`. Reading it as `props.owner` left the pill permanently absent without an error, which is why the package's own spec, which fed the nested shape by hand, could not see it.

The settings namespace and the plugin's copy dictionary are named apart (`ui-billing` and `billing`). One identifier for both binds the scope to the dictionary, which reads as an unregistered namespace: every surface renders its unavailable state while the Host serves correct values.

## Alternatives considered

**A core change to the shipped stat pills.** Extending ui-chat's own `StatsPills` and `TurnUsagePanel` with cost rows would have put the numbers in the exact seats the request named, but it would have made product money semantics — user-owned rates, a cached account balance — part of a package whose job is presenting provider-reported usage. A plugin that registers beside them keeps that separation and can be composed out.

**A Host projection unit for cost.** Computing cost on the Host and publishing it as a `sessionProjections` key would have moved the arithmetic off the browser, but a projection unit must be a deterministic fold of the durable log, and the rates are user configuration that is not in that log. A projection could only carry token buckets, which the browser can already accumulate from `tokenUsage`; the added unit would have bought nothing.

**A `Typert` Remote for the balance.** A Host Remote method would have been the canonical client-to-host call, but it needs a new generated contribution and a client namespace for one number that the page reads once and displays. Caching the read into the settings namespace reuses the transport the rates already ride and makes the balance visible to a plain document edit as well.

**Peak and off-peak rate schedules.** The provider's off-peak discount is half price inside fixed daily windows, so a schedule-shaped rate could track it more closely. It was rejected because the fold has no per-bucket timestamp: buckets arrive in per-attempt aggregates and a session total carries no time at all, so a schedule could only guess a window for tokens whose actual time is recorded per step. Three static rates state exactly what is known, and an operator who wants the discount can set the off-peak numbers.

## Consequences

**Bought.** The page is the only place rates live, and a route with no rates contributes to no total: the pills show a dash and the dialog names the route instead of showing a number the configuration cannot support. A session that switches providers mid-way prices each stretch correctly. The balance is always the DeepSeek account's, whichever provider the current turn ran on, which is what makes spend comparable to the one account the API can report.

**Cost.** A rate row is a route, not an attempt: a turn whose attempts fall outside the loaded window is priced under the routes the durable accounting names, with the remainder at the last of them, so the split between two routes of one retried turn is approximate even though the total is not. Cache writes are charged as uncached input, which matches how the DeepSeek adapters report usage but not a provider that reports writes in their own bucket. Nothing reconciles the computed total against a provider invoice; the balance moving between two reads is the only external check.

**Verification.** `packages/client/ui-billing/tests/cost.spec.ts` pins the folds, the money format, and the route-discovery join; `tests/host.host.spec.ts` mounts the Host half over an in-memory settings provider and pins the namespace, the cached read, waiting for the credential store, the failed-read path, and disposal; `tests/billing.client.spec.tsx` drives the three component surfaces and the plugin's registrations against the real `SlotRegistry`; `packages/client/ui-chat/tests/turn-tail-row.client.spec.tsx` pins both shapes of the completed-turn row, and `tests/chat-stats.client.spec.tsx` pins the trailing hole's divider and layout.

## Related

- [ui-billing package](../../../../packages/client/ui-billing/README.md) — the package's own contract, its settings value, and its cost folds.
- [Session projections](../../../../docs/subsystems/session-projection.md) — the `tokenUsage` value the session fold accumulates.
- [Web client architecture](../architecture/2026-07-19-gui-web-client-architecture.md) — how a browser plugin row registers slots.
