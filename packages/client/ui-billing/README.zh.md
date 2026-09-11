---
description: "Web 计费界面：用户自有的按模型单价、DeepSeek 账户余额，以及建立在其上的会话与本轮费用胶囊；面向费用显示的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-billing

[English](README.md) | 中文

## 概述

本包按用户自有的单价，为一次 Web 会话计价。它的 Host 半边注册 `ui-billing` settings 命名空间，并在其中缓存一份 DeepSeek 账户余额；浏览器半边渲染 composer 下方的两个费用胶囊、每个已完成轮次下方的一行费用，以及用于编辑单价的「计费」设置页。一条路由就是一对 `provider/model`，配三个「元 / 百万 tokens」单价：缓存命中输入、未命中输入与输出。余额始终是 DeepSeek 账户的余额，无论当前轮次跑在哪个提供方上。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

在 Web Chat 界面已存在的前提下挂载本插件；一旦知道某个单价或余额，胶囊就会出现，设置页出现在「设置 → 计费」。所有界面读取同一个 settings 值，因此没有 settings provider 的部署只是什么都不渲染。

### 单价

「计费」页列出部署可配置的每个提供方，并为该提供方自身 settings 配置声明的每个模型给出一行。每行携带该 `provider/model` 路由的三个单价：

| 单价 | 计入 |
|---|---|
| 缓存命中 | 由提供方缓存提供的提示词 tokens。 |
| 缓存未命中 | 未缓存的提示词 tokens，含缓存写入。 |
| 输出 | 生成的 tokens，含推理 tokens。 |

单价的币种与余额一致，单位为百万 tokens。没有单价的路由不进入任何合计：胶囊显示短横线，对话框点名该路由，而不是显示一个当前配置无法支撑的数字。单价存放在命名空间的 `models` 记录中，键为 `provider/model`，因此手工编辑 settings 文档与页面操作是同一份存储。

### 费用显示

composer 行在官方已有的轮次/步数胶囊与 token 胶囊同一行，带一个本会话费用胶囊和一个余额胶囊：composer dock 是一个每项一行、居中的纵向列，因此本行上移恰好一行的高度，并让自身内容从同一个 680px 封顶盒子的 41.2% 处开始，这正是避开那组胶囊可能达到的最宽读数的做法。会话合计累积 `tokenUsage` 投影——整份持久日志，而不是已加载窗口——按运行总量每次增长时生效的路由计价，这正是让会话中途换模型能被正确切分的原因。每个已完成轮次在操作图标上方得到自己的一行费用，该轮次的操作行保留其费用对话框，逐条列出参与本轮的路由。

这里不发起任何模型请求，也不写入任何会话事件：胶囊只是对提供方已经上报的用量做只读投影。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### settings 命名空间

`ui-billing` 保存一个值：

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

`models` 记录是用户配置，Host 只读取它来作答。`cache` 与 `cacheError` 属于 Host：Host 半边每次读取时解析 API key（先走 `credentials` seam，再走进程环境），对配置的基址调用 `GET /user/balance`，并把结果写回命名空间。`credentials` 是必需注入，因此首次读取会等待凭据文档，而不会把运维者确实存过的 key 报成缺失。读取失败会保留上一份快照并记录原因，因此对话框可以显示一个陈旧金额以及它为何陈旧。刷新链在每次结算后重新排期，并随插件 fiber 一起停止。

### 费用折叠

`tokenUsage` 是一个运行总量，两次读取之间的增量恰好就是某条路由被计费的部分，因此会话折叠为每次观察到的增长记录一段，并按各自的路由计价。编辑单价会重算每一段，切换模型会开始新的一段；两者都不会丢失历史。轮次折叠从持久的 turn-tail 账目出发——与官方「本轮用量」对话框所显示的同一份证据——并按已加载尝试中读到的路由拆分它；剩余部分（被重试的尝试）按最后一条路由的单价计入，使计价总额与提供方上报的 tokens 一致。

### 注册

三个界面，卸载时各自还原：`settings.section`（计费页）、`conversation.composer.dock`（两个胶囊，排在官方统计行之后），以及 `conversation.chat.turnTail` 链（每轮费用行，链优先级低于官方交付文件条目）。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当这些显示不够用时，读这些页面。它们从浏览器界面走向它所读取的测量与 settings 传输。

- [dsh-token-meter](../../llm/token-meter/README.zh.md) — 本包所累积的 `tokenUsage` 投影。
- [dsh-settings](../../settings/settings/README.zh.md) — Host 半边注册、浏览器半边编辑的命名空间 seam。
- [ui-settings](../ui-settings/README.zh.md) — 设置外壳，以及本页绑定的命名空间 scope。
- [ui-chat](../ui-chat/README.zh.md) — 本包所扩展的胶囊、对话框与 turn-tail 链。

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
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

- The per-turn node data lives only in the materialized Chat node store, not in the legacy compatibility slice the shipped stats row reads.
- `BillingTranslate` is declared locally because the framework's `PropsLocale` seat over a merged `LocaleNamespaceMap` is a superset of this package's dictionary keys; the two-faces-in-one-package layout means `src/settings.ts` is compiled by the Host leaf and consumed by the Client leaf through the project reference.
- settings 命名空间（`ui-billing`）与文案字典（`billing`）分开命名：两者共用一个标识符会把 scope 绑到字典上，于是 Host 明明在提供正确取值，而每个界面都渲染自己的「不可用」状态。

</details>

**Runtime invariant:** No companion is published. The package's two halves own no shared in-process state: the Host half owns the settings namespace registration and its refresh chain, and the browser half owns three slot registrations, each proven removed by the HMR-safety spec.
