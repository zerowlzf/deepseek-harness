---
description: "Web billing surface: user-owned per-model token rates, the DeepSeek account balance, and the session and turn cost pills over them; for users and maintainers of the cost display."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

English | [中文](README.zh.md)

## Summary

This package prices a Web session from rates the user owns. Its Host half registers the `ui-billing` settings namespace and caches one DeepSeek account balance in it; its browser half renders two cost figures under the composer, a cost pill in each completed Turn's own action row, and the Billing settings page that edits the rates. A route is a `provider/model` pair with three rates per million tokens: cached prompt input, uncached prompt input, and output. The balance is always the DeepSeek account's, whichever provider the current turn ran on.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin with the Web Chat surfaces present; the pills appear once a rate or a balance is known, and the settings page appears under Settings → Billing. Every surface reads the same settings value, so a deployment without a settings provider simply renders nothing.

### Rates

The Billing page lists every provider the deployment can configure, with one row per model that provider's own settings profile declares. Each row carries the three rates for that `provider/model` route:

| Rate | Charges |
|---|---|
| Cache hit | Prompt tokens served from the provider's cache. |
| Cache miss | Uncached prompt tokens, including cache writes. |
| Output | Generated tokens, reasoning tokens included. |

Rates are in the currency the balance reports, per million tokens. A route with no rates contributes to no total: the pills show a dash and the dialog names the route, rather than showing a number the configuration cannot support. Rates are stored in the namespace's `models` record under the key `provider/model`, so a hand edit of the settings document and the page are the same storage.

### Cost display

The composer row carries a session-cost figure and a balance figure inside the shipped turn/step and token pills' own line: `conversation.composer.stats` is a hole that ui-chat's stats row renders itself, so these figures are that row's own flex items and share the shipped group's centring and its 12px gap instead of landing beside it. That line is width-bound — at the 680px clamp its content box holds 616px, of which the two shipped pills, the row's three gaps, and both figures spend about 560 — so both figures are bare amounts (`¥16.82` and `¥15.96`, distinguished by the coin and wallet glyphs, and a bare `-` while one is unknown); each one states what it is through its accessible name and hover title rather than through visible words. The session total accumulates the `tokenUsage` projection — the whole durable log, not the loaded window — by pricing each growth of the running total at the route active when it grew, which is what keeps a mid-session model switch correctly split.

Each completed Turn carries its own cost pill in its action row, after the shipped 用量 and 用时 pills and before the message clock, through the `conversation.chat.turn-stats` hole. It shows `费用 ¥0.42` and opens that Turn's breakdown: one row per route, priced from the Turn's durable accounting and attributed by the route each loaded attempt was billed on. A Turn that also produced files shows both rows: the file row is the tail chain's own line above the action row, and the figures are a hole inside the row, so neither displaces the other. Three cases carry no figure, and the dialog says which one applies:

- the Turn's own accounting is absent (its events paged out, an attempt that never settled), exactly as its own 用量 pill shows nothing then — the session total is a session-wide number and never stands in for one Turn;
- its accounting names several routes and none of those attempts is still loaded, so the split cannot be made; the dialog names the routes it could not attribute rather than charging the whole aggregate once per route;
- a route it ran on has no configured rates, which the dialog names as unpriced.

An interrupted Turn keeps the row too: no closing message means no copy or branch target, but the accounting and the cost pill are what that row is for. A Turn that has not ended yet has no row — the shipped tail node appears when the Turn closes — so the newest answer carries its cost only once that Turn settles.

Nothing here issues a model request or writes a session event: the pills are a read-only projection of usage the providers already reported.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The settings namespace

`ui-billing` holds one value:

```yaml
models:
  bai/glm-5.3-flash:
    cacheHit: 0.15
    cacheMiss: 4.5
    output: 13.5
cache:
  total: 12.75
  currency: CNY
  available: true
  at: 1787667264186
cacheError: null
```

`models` is user configuration and the Host only reads it. `cache` and `cacheError` are Host-owned: the Host half resolves the API key per read (the `credentials` seam first, then the process environment), calls `GET /user/balance` on the configured base URL, and writes the answer back into the namespace. The `credentials` service is a required injection, so the first read waits for the credential document instead of reporting a key the operator did store as missing. A failed read keeps the previous snapshot and records the reason, so the dialog can show a stale amount and why it is stale. The refresh chain re-arms itself after each settlement and stops with the plugin fiber.

### Cost folds

`tokenUsage` is a running total whose growth between two reads is exactly what one route was billed, so the session fold records one stretch per observed growth and prices each under its own route. Editing a rate reprices every stretch, and switching models starts a new stretch; neither loses history. The turn fold starts from the durable turn-tail accounting — the same evidence the shipped Turn-usage dialog shows — and attributes it across the routes its loaded attempts were billed on, charging any remainder (a retried attempt, or one whose message left the window) at the last route's rate so the priced total matches the tokens the provider reported. A turn whose accounting the loaded window lost carries no figure; the session projection is never substituted for it, because a session-wide total read as one turn's cost is simply wrong.

### Registration

Three surfaces, each restored on unload: `settings.section` (the Billing page), `conversation.composer.stats` (the two figures inside the shipped composer stats row), and `conversation.chat.turn-stats` (the per-Turn cost pill inside the completed Turn's own action row). Both figure holes are list slots the owning row renders itself, and a row's owner share reaches an entry spread flat onto its props, so the Turn pill reads `turn` directly, the way the shipped produced-files entry reads `openFile`. Components type their props as the slot's four shares — `PropsRuntime` (owner share and session seats), `InjectFace` over this plugin's face, and `PropsLocale` — never as a hand-written list of members.

The settings page lists one card per provider whose profile the user layer configures, whose adapter is currently registered, or whose deployment-level profile carries models (the shipped official provider is one); a catalogue entry with none of those carries nothing to price and is left out. Each card's models come from that profile, and any route a stored rate row or a typed input names keeps its card, so a route whose provider disappeared stays editable and clearable.

The apply closure owns every ctx read. Components receive a `useBilling` selector hook over the namespace snapshot, a `useBillingGroups` hook over the loaded provider groups, and three plain callbacks: `routeGroups`, `saveRate`, and `clearRate`. The directory's own invalidations (`llm/adapters-updated`, `connection/reset`) are subscribed in the plugin, and the group list is one observable store, so a component holds no subscription machinery and never reaches for the context.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the displays are not enough. They move from the browser surfaces to the measurement and the settings transport they read.

- [dsh-token-meter](../../llm/token-meter/README.md) — the `tokenUsage` projection this package accumulates.
- [dsh-settings](../../settings/settings/README.md) — the namespace seam the Host half registers and the browser edits.
- [ui-settings](../ui-settings/README.md) — the settings shell and the namespace scope the page binds.
- [ui-chat](../ui-chat/README.md) — the pills, dialogs, and turn-tail chain this package extends.

-----

<a id="model-experience"></a>
## Model Experience

None, as both halves render and price facts the providers already reported for a human, and neither registers a prompt, tool schema, model call, or session event.

#### KV Cache effect

None; the package never assembles or sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current cost display. They are current package constraints, not a general billing comparison or a task backlog.

- **A Turn with incomplete accounting shows no cost** — the durable per-Turn accounting is all-or-nothing, so a Turn whose evidence is incomplete (its events paged out, an attempt that never settled) renders no figure rather than a wider session number. An old Turn can therefore read as costless while its answer is still on screen, which is the same abstention the shipped Turn-usage pill makes beside it.
- **A Turn that ran on several routes without a loaded attempt shows no cost** — attribution needs the route each attempt was billed on, so a Turn whose attempts all left the window cannot be split; the pill withholds the figure and the dialog names the routes. One named route is still priced, because every attempt ran there.
- **A retried attempt is charged at the route of the attempt the window kept** — the turn fold reads route attribution from the loaded window, so a Turn that retried on another route is charged for the attempts that survived there, with any remainder at the last of them. The priced total stays equal to the tokens the provider reported; the split between two routes of one retried Turn is approximate.
- **The session total is attributed from the browser's first sight** — the running total a page first observes is priced under the route active then, because the routes of everything before it are not in the evidence a browser can read; only later growth is split per route. A reload mid-session therefore re-reads the whole total under the route in use at that moment.
- **No figures appear before the shipped row does** — both composer figures ride ui-chat's stats row, which renders once the session has a step or billed tokens, so a brand-new session shows no balance until its first Turn. The per-Turn figure appears when that Turn closes, since the row itself is the shipped tail node's.
- **Cache writes are charged as uncached input** — the three configured rates match how the DeepSeek adapters report usage, where a cache write arrives as prompt input. A provider that reports writes in their own bucket is charged that bucket's tokens at its cache-miss rate.
- **Official rates are the operator's to enter** — the page marks the official provider but ships no price list: published DeepSeek prices change, and a rate table baked into this package would silently misprice a session until someone noticed. The three fields are the same for every provider, official included.
- **The balance is always the DeepSeek account's** — by design: the page compares spend against the one account the API can report. A deployment whose sessions never use the official provider still shows this balance, and the Host read is the only request this package makes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The per-turn node data lives only in the materialized Chat node store, not in the legacy compatibility slice the shipped stats row reads.
- ui-chat's completed-Turn extension above the action row is a chain that elects one entry, so a contribution there is dropped for every Turn the shipped produced-files entry claims; the cost figure lives in the row's own list hole (`conversation.chat.turn-stats`) instead. The per-attempt node kind is `assistant-step`, and its `finalNode.provenance` is the route that attempt was billed on.
- `BillingTranslate` stays declared locally while the props derive from `PropsLocale`: the framework's seat over a merged `LocaleNamespaceMap` accepts this dictionary's keys plus the shared common ones, which is assignable to the narrower local alias but not the reverse. The two-faces-in-one-package layout means `src/settings.ts` is compiled by the Host leaf and consumed by the Client leaf through the project reference.
- The settings namespace (`ui-billing`) and the copy dictionary (`billing`) stay separately named: one identifier for both binds the scope to the dictionary, so every surface renders its unavailable state while the Host serves correct values.

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the settings namespace registration and its refresh chain, and the browser half owns three slot registrations, each proven removed by the HMR-safety spec.
