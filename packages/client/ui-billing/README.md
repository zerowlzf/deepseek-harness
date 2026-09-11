---
description: "Web billing surface: user-owned per-model token rates, the DeepSeek account balance, and the session and turn cost pills over them; for users and maintainers of the cost display."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

English | [中文](README.zh.md)

## Summary

This package prices a Web session from rates the user owns. Its Host half registers the `ui-billing` settings namespace and caches one DeepSeek account balance in it; its browser half renders two cost pills under the composer, a cost row under each completed turn, and the Billing settings page that edits the rates. A route is a `provider/model` pair with three rates per million tokens: cached prompt input, uncached prompt input, and output. The balance is always the DeepSeek account's, whichever provider the current turn ran on.

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

The composer row carries a session-cost pill and a balance pill on the same line as the shipped turn/step and token pills: the composer dock is a centred column with one row per entry, so this row pulls itself up by the shipped row's height and starts its content 41.2% into the same 680px-clamped box, which is what clears the widest reading those pills can produce. The session total accumulates the `tokenUsage` projection — the whole durable log, not the loaded window — by pricing each growth of the running total at the route active when it grew, which is what keeps a mid-session model switch correctly split. Each completed turn gets its own cost row above the action icons, and the turn's action row keeps its cost dialog with a row per contributing route.

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

`tokenUsage` is a running total whose growth between two reads is exactly what one route was billed, so the session fold records one stretch per observed growth and prices each under its own route. Editing a rate reprices every stretch, and switching models starts a new stretch; neither loses history. The turn fold starts from the durable turn-tail accounting — the same evidence the shipped Turn-usage dialog shows — and splits it across the routes read from the loaded attempts, charging any remainder (a retried attempt) at the last route's rate so the priced total matches the tokens the provider reported.

### Registration

Three surfaces, each restored on unload: `settings.section` (the Billing page), `conversation.composer.dock` (the two pills, ordered after the shipped stats row), and the `conversation.chat.turnTail` chain (the per-turn cost row, at a lower chain priority than the shipped produced-files entry).

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

- **A rate row is one route, not one attempt** — the turn fold reads route attribution from the loaded window, so a turn whose attempts are outside that window is priced under the routes the durable accounting names, with the remainder at the last of them. The priced total stays equal to the tokens the provider reported; the split between two routes of one retried turn is approximate.
- **Cache writes are charged as uncached input** — the three configured rates match how the DeepSeek adapters report usage, where a cache write arrives as prompt input. A provider that reports writes in their own bucket is charged that bucket's tokens at its cache-miss rate.
- **The balance is always the DeepSeek account's** — by design: the page compares spend against the one account the API can report. A deployment whose sessions never use the official provider still shows this balance, and the Host read is the only request this package makes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

- The per-turn node data lives only in the materialized Chat node store, not in the legacy compatibility slice the shipped stats row reads.
- `BillingTranslate` is declared locally because the framework's `PropsLocale` seat over a merged `LocaleNamespaceMap` is a superset of this package's dictionary keys; the two-faces-in-one-package layout means `src/settings.ts` is compiled by the Host leaf and consumed by the Client leaf through the project reference.
- The settings namespace (`ui-billing`) and the copy dictionary (`billing`) stay separately named: one identifier for both binds the scope to the dictionary, so every surface renders its unavailable state while the Host serves correct values.

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the settings namespace registration and its refresh chain, and the browser half owns three slot registrations, each proven removed by the HMR-safety spec.
