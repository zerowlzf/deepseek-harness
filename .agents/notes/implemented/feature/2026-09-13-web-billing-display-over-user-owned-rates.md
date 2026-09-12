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

Three surfaces, each restored on unload: `settings.section` (the Billing page), `conversation.composer.stats` (the session-cost and balance figures), and `conversation.chat.turn-stats` (the per-Turn cost pill).

The composer figures belong to a line ui-chat already owns, so ui-chat declares the hole and its own stats row renders it: `conversation.composer.stats` is a session-scope `list` child of the `conversation.composer.dock` row, and the rendered children take that row's own 12px gap, so every pair on the line reads at one distance. An earlier arrangement — a second dock row pulled up by the row's height and offset so its content began after the shipped pills — could only guess where a centred group of changing width would end, and drew through it when the guess was wrong; a divider the row drew before the contribution then spent 13px of the width-bound line to space figures the row's own gap already spaced.

The per-Turn pill hangs off the Turn's own action row, which now renders for a Turn interrupted before any finalized text. That arm previously returned before the row existed, so an interrupted Turn showed neither the shipped usage figures nor any contribution beside them; every Turn of a session where the user interrupts mid-run therefore showed no cost at all. A Turn carrying nothing to show — no closing message, no contribution, no accounting, and later evidence in its own turn — still renders nothing.

The figures sit inside that row rather than on the tail chain above it, because the chain elects exactly one entry: for every Turn the shipped produced-files entry claimed, the cost pill was dropped without a trace. `conversation.chat.turn-stats` is a session-scope `list` child of the `turn-tail` Chat node, rendered by `TurnTailNodeView` after the shipped Turn-usage and Turn-time pills, and the row rebates the trailing figure into the pill cluster the way the pills rebate between themselves.

The pill prices the durable turn-tail accounting, attributed per route by the attempts the loaded window holds, and shows nothing when that accounting is absent: the session projection is a session-wide running total, so reading it as one Turn's cost printed the whole session on the Turn's own row. Attribution needs the route each attempt was billed on, which the Chat fold now keeps on the settled `assistant-step` node — `finalNode.provenance`, the durable `message.source` a sibling Definition already records — so a Turn that switched models is priced per route instead of never being split at all. A Turn whose accounting names several routes while none of their attempts is still loaded cannot be split, and yields no priced row rather than stating the aggregate under each route, which would charge the Turn once per route; the dialog names the routes it could not attribute. One named route is still priced exactly, because every attempt ran there.

The settings page follows the shipped Models page: one card per provider the user configured, that the adapter currently serves, or that a deployment-level profile gives models — the shipped official provider is the last kind — with the provider's models behind that card's own edit control. A catalogue entry with none of those carries nothing to price and contributes no card.

The apply closure owns every ctx read. Components take a `useBilling` selector hook over the namespace snapshot and a `useBillingGroups` hook over the loaded groups — both bound by the renderer from bare sources in the `hooks` compartment — plus plain `routeGroups`, `saveRate`, and `clearRate` callbacks. The directory's invalidations are subscribed in the plugin, and nothing loads until the page asks, so mounting the plugin issues no request at all.

A row's owner share reaches an entry spread flat onto its props, never nested under `owner`: the renderer hands a component `{...ownerProps, ...}`, so the per-Turn pill reads `turn` directly the way the shipped produced-files entry reads `openFile`. Reading it as `props.owner` left the pill permanently absent without an error, which is why the package's own spec, which fed the nested shape by hand, could not see it. Every component types its props as the slot's shares — `PropsRuntime`, the plugin's `InjectFace`, and `PropsLocale` — instead of restating the members, so a seat the framework adds reaches them without an edit here.

The settings namespace and the plugin's copy dictionary are named apart (`ui-billing` and `billing`). One identifier for both binds the scope to the dictionary, which reads as an unregistered namespace: every surface renders its unavailable state while the Host serves correct values.

## Alternatives considered

**A core change to the shipped stat pills.** Extending ui-chat's own `StatsPills` and `TurnUsagePanel` with cost rows would have put the numbers in the exact seats the request named, but it would have made product money semantics — user-owned rates, a cached account balance — part of a package whose job is presenting provider-reported usage. A plugin that registers beside them keeps that separation and can be composed out.

**A Host projection unit for cost.** Computing cost on the Host and publishing it as a `sessionProjections` key would have moved the arithmetic off the browser, but a projection unit must be a deterministic fold of the durable log, and the rates are user configuration that is not in that log. A projection could only carry token buckets, which the browser can already accumulate from `tokenUsage`; the added unit would have bought nothing.

**A `Typert` Remote for the balance.** A Host Remote method would have been the canonical client-to-host call, but it needs a new generated contribution and a client namespace for one number that the page reads once and displays. Caching the read into the settings namespace reuses the transport the rates already ride and makes the balance visible to a plain document edit as well.

**Peak and off-peak rate schedules.** The provider's off-peak discount is half price inside fixed daily windows, so a schedule-shaped rate could track it more closely. It was rejected because the fold has no per-bucket timestamp: buckets arrive in per-attempt aggregates and a session total carries no time at all, so a schedule could only guess a window for tokens whose actual time is recorded per step. Three static rates state exactly what is known, and an operator who wants the discount can set the off-peak numbers.

## Consequences

**Bought.** The page is the only place rates live, and a route with no rates contributes to no total: the pills show a dash and the dialog names the route instead of showing a number the configuration cannot support. A session that switches providers mid-way prices each stretch correctly. The balance is always the DeepSeek account's, whichever provider the current turn ran on, which is what makes spend comparable to the one account the API can report.

**Cost.** A rate row is a route, not an attempt: a Turn that retried on another route is charged for the attempts the loaded window kept, with the remainder at the last of them, so the split between two routes of one retried Turn is approximate even though the total is not. A Turn whose accounting is incomplete — or whose several routes left the window with no attempt — shows no figure at all, so an old Turn can read as costless while its answer is still on screen. The session total is attributed from the browser's first sight of the running total: everything the log billed before that page opened is priced under the route active then, so a reload mid-session re-reads the whole total under one route. Neither composer figure appears before the shipped stats row does, so a brand-new session shows no balance until its first Turn. Cache writes are charged as uncached input, which matches how the DeepSeek adapters report usage but not a provider that reports writes in their own bucket. Nothing reconciles the computed total against a provider invoice; the balance moving between two reads is the only external check.

**Verification.** `packages/client/ui-billing/tests/cost.client.spec.ts` pins the folds, the money format, and the route-discovery join; `tests/host.host.spec.ts` mounts the Host half over an in-memory settings provider and pins the namespace, the cached read, waiting for the credential store, the failed-read path, and disposal; `tests/billing.client.spec.tsx` drives the three component surfaces and the plugin's registrations against the real `SlotRegistry`, including the abstention for a Turn whose own accounting is absent and the decline for one whose several routes have no loaded attempt; `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` pins the billed route on the settled assistant node, `tests/turn-tail-row.client.spec.tsx` pins both shapes of the completed-Turn row and the trailing figures' place inside it, `tests/chat-stats.client.spec.tsx` pins the composer contribution as the row's own flex item, and `tests/turn-tail-spacing.client.spec.ts` pins both rows' spacing contracts.

## Related

- [ui-billing package](../../../../packages/client/ui-billing/README.md) — the package's own contract, its settings value, and its cost folds.
- [Session projections](../../../../docs/subsystems/session-projection.md) — the `tokenUsage` value the session fold accumulates.
- [Web client architecture](../architecture/2026-07-19-gui-web-client-architecture.md) — how a browser plugin row registers slots.
