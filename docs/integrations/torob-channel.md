# Torob as a channel inside Growth (issue #894)

**Status:** Waves 1 and 2 delivered — the foundation (which managed website may become a Torob shop,
the shop lifecycle, the credential) and the **product feed** (integer-Toman pricing, one item per
sellable page, 100-per-page paging, and a recorded build with its skip reasons). Waves 3–6 (serving
the feed from the storefront runtimes, the partner approval path, the per-shop screen, attribution)
are listed in §7 and are **not** built. Nothing in this page claims a product is indexed on Torob,
because nothing here can know that.

## 1. What this is, and what it is not

Torob is a **section of Growth** — `/growth/torob` — not a second app, wizard or product editor. A
business opens it and sees the websites the platform already manages for it, one row each, with the
one action that row allows.

It is also **not a managed service yet**, in the sense of
[`managed-services.md`](./managed-services.md): in Wave 1 the platform holds a *merchant's* Torob
token at their request, not a supply relationship of its own. Registering it in the managed-services
inventory before the partner application, the wallet and the tariff exist would be the exact kind of
"registered but unbuilt" entry §5q of the #902 plan refused to add. That registration is a later
wave's decision, and `inventory.ts` stays untouched until then.

## 2. The one rule everything else serves

> Only platform-managed, actively connected, authorized websites may enroll. No pasted URLs.

This is enforced as a property of the data path, not as a form validation:

- `torob_shops` stores which website a shop belongs to as `(website_kind, source_connection_id)` — a
  **soft** reference to `integration_connections` (WooCommerce) or `eshobe_cms_connections`
  (Eshobe CMS), because the two registries have different shapes and a foreign key cannot express
  "one of two".
- `connectTorobShop` therefore re-reads the website **from the caller's own tenant** on every write
  and refuses unless it is there, active and catalogue-capable. A connection id in a request is a
  claim, not a fact; a uuid belonging to another business is `website_not_found`, not a 403 with a
  hint that it exists.
- There is no input shape anywhere in `src/lib/torob/eligibility.ts` that a pasted address could be
  coerced into. That is cheaper to keep true than a validator someone later loosens.

## 3. The five states, and the two this wave can honestly report

The issue's sharpest requirement is that these are **never conflated**:

| Fact | Wave 1 | Source |
| --- | --- | --- |
| site catalogue ready | ✅ | the connection is active; for WooCommerce, `sync_products` is on |
| Torob API ready (credential works) | ~ shape only | the token's form locally; Torob's own 401 is the verdict |
| Torob connection approved | ✅ | `authorization_state` |
| Torob webhook accepted | ❌ Wave 2 | needs the feed |
| actually listed / indexed on Torob | ❌ Wave 3 | needs the Shop API |

So the screen says «متصل» and means **authorized**. The API response carries
`capabilities: { authorization: true, feed: false, listing: false, attribution: false }` and the page
renders a note that a connected shop is not a listed product. A green badge that a merchant reads as
"we are on Torob" when nothing is published is the failure this table exists to prevent.

## 4. Lifecycle

```
                 connect (partner)            approval
   (no row) ──────────────────────▶ not_authorized ─────────▶ pending_approval ──▶ authorized
        │                                  │                                        │
        │ connect (manual token)           │ revoke                                 │ revoke
        └──────────────────────────────────┴───────────────▶ revoked ◀──────────────┘
```

- **Connect is idempotent.** `UNIQUE (business_id, website_kind, source_connection_id)` plus
  `ON CONFLICT DO NOTHING` and a re-read of the winner: a double-click, a retried request or a second
  tab cannot mint a second shop — or, from Wave 2, a second Torob registration.
- **One shop per domain.** `UNIQUE (business_id, domain)`. Two registries can legitimately point at
  one host (a WooCommerce plugin and the CMS site it runs inside); the resolver marks the second
  `needs_attention` / `domain_already_enrolled` before anyone clicks, and the constraint is the
  backstop.
- **Manual token authorizes immediately** (`auth_mode = 'manual_token'`) because a merchant who
  pasted a working token is not waiting for an approval that is not part of that flow. Partner mode
  waits: an accepted request is *not* an approved shop.
- **Disconnect stops work; it never deletes.** `enabled = false` for a switch, `authorization_state =
  'revoked'` plus the ciphertext removed for a revocation. The row, the domain and the merchant's
  Torob registration all survive, so recovery is the same idempotent operation as first connection.
- **Enabling requires `authorized`.** An "on" channel with no credential is a queue that fills and
  never drains, and the screen would look healthy over a feed that cannot work.

The state machine is also a database constraint (`torob_shops_credential_matches_state`): an
authorized shop has a credential, a pending or revoked one does not, and no path — present or future
— can write a row that claims otherwise.

## 5. The credential

The merchant's Shop API token is encrypted with the realm key (`secrets.ts`,
`INTEGRATIONS_ENCRYPTION_KEY` falling back to `JWT_SECRET`) and is read by exactly one function,
`readTorobShopToken`, for exactly one purpose: signing a request to Torob. Every read path returns
`token_hint` (last four characters) and nothing else, and the audit entries record the hint, never
the secret. Revocation deletes the ciphertext rather than leaving a secret in a row whose state says
nobody uses it.

An undecryptable ciphertext (a deployment whose key changed) resolves to `null` and not to a guess:
sending an unauthenticated request to Torob under our name is worse than reporting that the
credential cannot be read.

The deployment's own Torob settings, all optional — each absence degrades to a stated behaviour rather
than to a silent failure:

| Variable | What it is | Without it |
| --- | --- | --- |
| `TOROB_PARTNER_TOKEN` | the partner token Torob issued for this platform's Shop Generator application (also restricted to registered IP addresses on their side) | the automatic approval flow answers `not_configured` and the screen offers the merchant's own token instead |
| `TOROB_RETURN_URL_BASE` | the public origin Torob sends the merchant's browser back to; defaults to the tenant origin of the request | the request's own origin is used, which behind a proxy may not be the https address Torob requires |
| `TOROB_API_PUBLIC_KEY` | Torob's Ed25519 verification key for the Product API; defaults to the key published in their token guide | the published key is used |
| `TOROB_SHOP_GENERATOR_BASE_URL` | overrides Torob's Shop Generator base URL | `https://api.torob.com/shop-generator/v1/` |

## 6. Permissions

Torob's keys live in Growth's band, because the channel lives in Growth:

| Key | What it opens |
| --- | --- |
| `torob.view` | the section: which websites exist and each one's channel state |
| `torob.manage` | connect, switch publication on/off, disconnect |
| `torob.configure` | the merchant's own token and the publication rule — credential-shaped, so its own key and its own audit trail |

Owner, admin and manager hold all three: a manager already runs the websites this channel publishes
from (`website.*`, `woocommerce.*`), so withholding Torob would mean the person who owns the catalogue
cannot put it on the channel. The accountant and the till hold none of them. `GROWTH_API_PERMISSIONS`
declares the route, and `growth-access.test.ts` checks the handler's actual guards against it — a
button is never shown for a request that would come back 403.

## 6a. The feed (Wave 2)

Three rules, each enforced by a test rather than by discipline:

1. **Money is integer Toman, or the product is refused.** `menu_items.price` holds integer Rial;
   `currency.ts` divides by ten only when the division is exact, and refuses an unsupported currency
   outright (`EUR`/`USD` are legitimate `site_currency` values and this platform holds no rate).
   Rounding was rejected on purpose: a feed price that disagrees with the storefront by a few Rial is
   a price the merchant never set.
2. **One item per sellable page.** A variant product becomes one item per variant, each with its own
   `page_unique` and URL — never the parent priced at its cheapest variant. `page_unique` is a local
   uuid (or `product~variant`), so it survives a rename; two catalogue rows claiming one URL are
   refused as `duplicate_page` rather than letting Torob choose.
3. **Order is deterministic.** Items sort by `page_url` then identity, and paging cuts the whole
   ordered list, so page 1 is page 1 on the next refresh and a crawler cannot lose the tail of the
   catalogue between requests.

`torob_feed_runs` records every build: counts, page count, and the skip reasons grouped. Its `status`
vocabulary stops at `built` and `blocked` — there is deliberately no `sent`, because sending is the
runtime's job and its proof is Torob's response. This is the table that answers «چرا این محصول در
ترب نیست؟» without re-running anything.

A page URL is composed from the shop's `public_product_path` — the *manager's* storefront route,
copied at connect time (`/product/{id}` for WooCommerce, `/products/{id}` for the CMS) and editable
per shop, so the guess lives in one column instead of inside the builder.

The screen's «پیش‌نمایش فید» button shows what would be sent and why anything is missing; it says
«آمادهٔ ارسال», never «منتشر شد».

## 6b. The endpoint the crawler reads (Wave 3)

```
POST https://<shop-domain>/api/v1/torob/products/<shopId>
X-Torob-Token: <jwt>
X-Torob-Token-Version: 1
```

The shop registers that address in its Torob panel; Torob then mints a token whose `aud` is the
shop's own hostname, which is what makes the audience check mean something on a platform that hosts
many shops. Everything about the request is Torob's contract and lives in `src/lib/torob/contract.ts`
beside the document it came from — `api_version: "torob_api_v3"`, 100 products per page,
`date_added_desc`/`date_updated_desc`/`product_id_desc`, cursor paging only over `product_id_desc`, and
exactly one request mode per body (`page_urls`, `page_uniques`, `page` + `sort`, or `cursor` + `sort`).
A body with no mode is a `400`, never a defaulted page 1: a crawler that receives page 1 for a
malformed request believes it has synced the shop.

The order of operations is the security model, and it is the same order in the code:

1. **Rate limit per shop** — five requests per second, keyed on the path's shop id, so one crawl
   cannot spend another shop's budget and a flood is refused before a database round trip.
2. **Resolve the shop before any tenant scope exists.** The path id is opaque; the lookup runs under
   the documented `torob-product-api-auth` bypass (see `src/lib/db.ts`) and returns `business_id`,
   which is how the tenant becomes known. Every later statement runs inside `withTenant`.
3. **Refuse anything not publishable as a plain `404 not_found`** — unknown, unauthorized, switched
   off, or whose website is gone. A shop that may not be served must not be discoverable, so all five
   answers are identical.
4. **Verify the token before reading the catalogue.** EdDSA only, `exp`/`nbf` enforced, and `aud`
   compared against `torob_shops.domain` — never against the request's `Host`. The failure reason is
   part of the `401` body (`unauthorized: audience_mismatch`, `unauthorized: expired`, …) because a
   partner integration with no reason is the hardest thing to debug.
5. **Only then build and answer.** The catalogue is assembled exactly as «پیش‌نمایش فید» assembles it,
   so page 7 of a crawl and the merchant's preview can never disagree.

A request that is refused, and a product that is withdrawn, are different things: the first is a
`400`/`401`/`404` with `{ error }`, the second is simply absent from `products`. The contract's price
trap is enforced in one place — `availability: false` with `current_price: 0` for something sold out,
because `true` with `0` means **free** to Torob, and a withdrawn product is omitted rather than left
on display at its last known price.

Nothing about this endpoint claims a listing. It proves the catalogue can be *served*; whether Torob
accepted it, indexed it, or rejected the domain is Torob's own fact and arrives later.

## 6c. The partner approval flow (Wave 3)

```
merchant → POST /api/growth/torob/shops {action:"authorize"}
         → Torob POST /shop-generator/v1/connections/   (shop_domain, return_url)
         → 302 to approve_url  (merchant logs into Torob and approves)
         → Torob redirects the browser to /api/growth/torob/authorize/callback?connection_id=…&code=…
         → Torob POST /shop-generator/v1/connections/{id}/confirm/ (code)
         → Torob answers `active` → the shop is `authorized`
```

Four things about that sequence are decisions, not plumbing:

1. **An accepted request is not an approved shop.** `pending_approval` means Torob has opened a
   connection and the merchant has not decided; the row becomes `authorized` only when Torob's
   `confirm` answers `active`. Torob's five connection statuses map onto the platform's four states in
   `authorization-service.ts` and nowhere else.
2. **The callback resolves the shop by the connection id it stored**, never by a shop id in the browser's
   URL. Torob's document names the attack this prevents: "*a user of the platform could add another
   shop's domain and get the real owner to approve it*". A connection id belonging to another business
   resolves to nothing, even for a signed-in merchant.
3. **The 15-minute window is stored, not inferred.** `authorization_requested_at` is written when the
   request is made, the schema refuses a `pending_approval` row without it, and a code that arrives late
   is refused before it is sent — the row then says `expired` rather than looking like a network fault.
   Asking again reuses Torob's `connection_id`, replaces the `return_url` and restarts the clock.
4. **A denial is a decision.** The merchant who says no in Torob's panel sends the row to `revoked` with
   `authorization_error = 'denied'` and the channel off. Nothing is deleted: their Torob shop still
   exists, and the screen offers a fresh request.

The approval page is opened with `location.assign` rather than in a new tab, because Torob's code is tied
to the browser session that started the request. The `code` is never written to an audit row, never
echoed back in the redirect, and never stored.

## 6d. What a shop publishes (Wave 4)

`/growth/torob/[shopId]` is the per-shop page, and the question it answers is the merchant's own:
*which of my products go to Torob, and why does one not?* One rule plus one decision per product:

| rule | what it publishes | a product nobody touched |
| --- | --- | --- |
| «همهٔ محصولات» (`all`) | the catalogue, **minus** the products marked `exclude` | published |
| «فقط محصولات انتخابی» (`selected`) | **only** the products marked `include` | not published |

They are one question asked from opposite ends, which is why both live in one table
(`torob_shop_products`, migration 0282) with a single `decision` column rather than an inclusion list
and an exclusion list that could disagree. The rule decides which decision is doing the work; the
decisions are kept when the rule changes, so a merchant who flips back and forth loses nothing, and
clearing a decision returns a product to the rule instead of leaving it switched off out of sight.

The table is deliberately thin — an id, a decision, who and when. Names and prices stay in
`menu_items`; copying them would make a second catalogue that drifts, and Torob would end up showing a
price the storefront no longer charges. `product_id` is a soft reference (retail `items` are coming),
so `setProductDecision` verifies every id against the tenant's own catalogue and reports how many it
refused rather than silently dropping them.

Four states a product can be in, and the boundary between them is the point of the page:

| state | meaning |
| --- | --- |
| «در فید ترب» | the platform would send it, complete and priced |
| «کنار گذاشته‌اید» | the merchant switched it off (`exclude`) |
| «انتخاب نشده» | rule is `selected` and it has not been chosen |
| «منتشر نمی‌شود» | wanted, and a catalogue rule stops it — the feed builder's own reason, in Persian, with the link that fixes it |

The first three are the merchant's answer; only the last is a problem, and it is never conflated with
them. The page's summary is `summariseFeed` — the same function «پیش‌نمایش فید» uses — so the two can
not disagree about how many products a shop would send. Every decision and rule change is audited with
the product ids and the counts; the audit never contains anything the catalogue owns.

Reading the page is `torob.view`; changing the rule, the sold-out preference or a decision is
`torob.configure`, the same key as the merchant's token, because both are channel settings rather than
relationships.

## 6e. What Torob says (Wave 4b)

Everything up to here describes the platform's side of the channel. `GET /shop/` and `POST /products/`
on the Torob **Shop API** are the other direction: the shop's status on Torob, a precomputed product
summary, and one status list per page. The section is `/growth/torob/[shopId]`'s «وضعیت در ترب» panel,
fed by `GET /api/growth/torob/shops/[id]/status`, and it exists because the epic's sharpest rule is
that *feed built*, *webhook accepted* and *actually indexed* are three different claims:

| stage | who knows it | shown as |
| --- | --- | --- |
| feed | us — `summariseFeed` and the publication rules (§6d) | «آماده در فید» |
| sent | nobody yet — the webhook outbox is Wave 6 | always `false` in `capabilities` |
| listing | Torob — the Shop API read | «نمایش در ترب», only once Torob has answered |

A refresh is a `POST` and a read (`GET /shop/`, `POST /products/` — the document's own verb for a
listing). Nothing on Torob changes, so both verbs are `torob.view`, the same key «پیش‌نمایش فید» uses.
Opening the page never calls Torob: the panel reads the stored snapshot (`GET`), and the provider's
five-requests-per-second-per-shop limit is spent only when the merchant asks.

Three things the panel refuses to do:

* **Call `product_summary` live.** Torob recomputes it at least every two days and says so twice;
  `calculated_at` is printed beside the numbers, and `null` reads as «محاسبه نشده», not as «no
  products». When the groups do not add up to `total`, the difference is stated rather than hidden.
* **Erase the last answer on a failure.** `observed_at` moves only on success; `observed_error` records
  why the last *attempt* failed, so a failed read says "this is what Torob said on Tuesday, and today
  it did not answer" instead of showing an empty panel. `health` follows the last check (`attention`
  with the failure code), which is what makes "needs attention" observable rather than decorative.
* **Treat absence from a partial scan as deletion.** `torob_product_states` is Torob's current view, so
  a **complete** scan replaces it (a product Torob stopped returning is gone); a `truncated` scan — more
  pages than one refresh reads (`TOROB_SHOP_API_MAX_PAGES`) — deletes nothing.

The client (`shop-api-client.ts`) is careful about three things the document warns about. Requests are
spaced to the five-per-second-per-shop limit, and a `429` is retried honouring `Retry-After` before it
is reported as `rate_limited`. Pagination follows the **cursor only** — the `next` link Torob returns is
never requested, so our bearer token cannot be aimed at another host. And a status this build does not
know is *counted*, not folded into a neighbouring one: the table's `CHECK` lists the eleven documented
values, so an unknown string cannot become a sentence we never wrote.

A read needs a credential: the merchant's own token in manual mode, the platform's generator token in
partner mode, and a shop with neither is answered `not_configured` — before the network, like the
`not_authorized`/`channel_disabled` cases. That is the same reading of "disconnect stops managed
operations" the rest of the feature uses: a channel that is off is not polled.

The multi-shop section (`GET /api/growth/torob/shops`) also carries one observation line per shop —
Torob's status, how many products it reports, how many carry a problem, when it was last read, and why the
last attempt failed. It is read in **one** query over both Torob tables and it too never calls Torob. A
shop that has never been read is simply absent from that list: the screen renders «از ترب خوانده نشده»
rather than an empty panel, because "no products on Torob" and "nobody has asked Torob" look identical
and are entirely different problems.

## 6f. Telling Torob what changed (Wave 5b)

The Product API is Torob pulling from us on Torob's schedule. The **Product Webhook**
(`POST https://api.torob.com/update/webhook/v1/`) is us saying "these pages changed, pull them
sooner", and it is the last P0 piece of the epic: without it a shop waits for a crawl.

Three invariants come from the document and are enforced in `webhook.ts`, once:

| invariant | where |
| --- | --- |
| at most **100 items** per request, **20 requests/minute/shop** | `planWebhookBatches`, `TOROB_WEBHOOK_BATCHES_PER_RUN = 4` per run |
| **one domain per request** (400 otherwise) | an item whose URL is not on the shop's own domain is dropped and counted, never sent |
| the payload is `{page_url, page_unique}` — **nothing else** | `webhookBody`; no price, no title, no stock, because Torob re-fetches the page itself |

The queue is one row per **page** (`torob_webhook_outbox`, migration 0284), so a shop that changes a
price three times in a minute re-arms one row instead of growing a queue of three events. Rows are
filled from the **built feed** — the same `readShopCatalogue` the crawler is served from — so the
platform never announces a page it would not serve: a product the merchant excluded (§6d) or withdrew
loses its row rather than being sent to Torob. `reason` distinguishes «تازه» from «به‌روزشده» by asking
the outbox whether Torob was ever told about the page.

A drain claims up to 100 due rows with `FOR UPDATE SKIP LOCKED`, pushing `next_attempt_at` forward by a
five-minute lease; a crash between claim and send therefore costs one interval rather than a lost
notice. That is **at-least-once**, deliberately: the webhook's only effect is "please re-fetch", and
fetching a page twice is free. A send that fails is settled per row:

| failure | what happens | why |
| --- | --- | --- |
| `400 invalid_request`, `400`/`403 domain_mismatch` | dead-letter at once | retrying the same body repeats the same refusal |
| `401 unauthorized`, `403 shop_not_active` | dead-letter, and the shop's `health` becomes `attention` | a human has to fix the credential or the shop's state |
| `429 rate_limited` | stays `pending`, due after the documented spacing (3 s) | this is exactly what waiting fixes |
| timeout, `5xx` | backoff, dead-letter at the attempt cap (8) | the ordinary outage path |

Every request is recorded in `torob_webhook_batches` — items, `accepted` or `failed`, and the reason —
so "rate limited", "refused" and "stopped" are visible on the screen instead of only in a log line. A
`200 {"message": "success"}` is stored as **accepted** and never as indexed: the document says so twice,
and the per-shop screen's three stages now read `sent` from this table (`capabilities.sent` is no longer
a constant `false`) while `listing` still comes only from Torob's own answer (§6e).

Disconnecting stops sending. An unauthorized shop, a switched-off channel, or a shop whose token Torob
refuses is not drained — the same reading of "disconnect stops managed background operations" the read
side (§6e) already applies. The tick (`runTorobWebhookTick`, central, every minute) enumerates only
`enabled AND authorized` shops.

Surface: `GET/POST /api/growth/torob/shops/[id]/webhook` — `GET` the queue (ours only, never Torob),
`POST {action: "drain"}` to send now and `{action: "retry"}` to revive stopped pages. Reading is
`torob.view`; both writes are `torob.configure`, because sending spends the shop's own rate budget.

## 6g. Turning a page off on Torob, and «تعمیر» (Wave 5c)

Everything up to here describes a shop that is either fine or stuck. Two merchant actions close that:
one changes a single page **on Torob**, and one re-runs the whole channel for a shop in one step.

**Switching a page.** `POST /products/activate/|deactivate/?domain=<host>` with `{product_ids}` (the
Shop API's own id for a page — `page_unique`) answers **per id**: `{product_id, found}`. Consequences
that the code keeps:

| rule | where |
| --- | --- |
| only pages Torob already knows can be switched — an unknown id comes back not-`found` and is reported as «اعمال نشد», never as success | `setTorobPagesActive` |
| ≤ 5 000 ids per request; the screen sends one page per click and the route caps at 500 | `TOROB_ACTIVATE_BATCH_LIMIT`, the `pages` route |
| **deactivation is not deletion** — the page stays with Torob and can be switched back on | copy on the button, and the doc's own wording |
| our snapshot is not rewritten from the answer | `setPagesOnTorob` writes nothing; `torob_product_states` changes only when Torob is read (§6e) |

The guard is the same one the crawler gets (§6e): authorized, switched on, and with a credential,
all answered **before** the network — a shop the merchant disconnected cannot change anything on
Torob from a stale screen. In partner mode the deployment's `TOROB_PARTNER_TOKEN` authenticates it.
Every switch is audited (`torob.page.toggle`).

**«تعمیر»** is announce → tell → read, in that order (`repairShop`): fill the webhook queue from the
built feed, drain it now instead of waiting for the minute tick, then read Torob back. Reading first
would show yesterday's view of the shop being repaired; announcing without reading leaves the
merchant unable to see whether the announcement was accepted. Each step reports itself rather than
collapsing into one boolean — "the queue is full and Torob will not answer" is a different problem
from "everything is fine" — and each is guarded by its own service, so a shop that may not send still
gets its read. It is **not** a retry of everything: `dead` pages stay dead until somebody looks at the
reason, which is the queue's own action (§6f), and a switched-off shop answers `stoppedBy` instead of
sending behind the merchant's back. Audit: `torob.shop.repair`.

Surface: `POST /api/growth/torob/shops/[id]/pages` `{pageUniques, active}` and
`POST /api/growth/torob/shops/[id]/repair`. Both are `torob.configure`, because both change the
channel and spend the shop's rate budget.

## 6h. Attribution — the store answers, and only when it says so (Wave 6)

Torob refers a shopper with `?torob_clid=…` and later asks the shop for the purchases
that came from that click (`order_tracking_api.md`, `action_tracking_api.md`). The
epic's rule is one sentence — **off by default, `403` when off** — and it decides the
shape of the whole feature:

| consequence | where |
| --- | --- |
| the endpoint is the **store's own origin**, under a path ending `/torob/v1/orders` (or `/actions`); orders live in WooCommerce, so the answer is built by the plugin | `wordpress-plugin/pos-accounting-connector/includes/class-pos-torob.php` |
| two independent switches, both absent-by-default; only an exact `1` counts as consent | `POS_Connector_Torob::is_enabled` / `set_enabled` |
| `403 {"success":false,"error":"access_disabled"}` — the refusal is a response, not a decision to send nothing | `guard()` |
| token → switch → parameters, in that order: the endpoint is not an oracle for a store's settings, and a disabled store never touches an order | `open_channel()` |

The token rules are the same `EdDSA`/`aud`/`exp`/`nbf` set as §6b, verified against the
site's own host (`home_url()`), with the document's one tolerated spelling: an `aud`
that carries a port still names the same store. `alg: none` is refused before the
signature is looked at. The only accepted version header is `1`.

`torob_clid` is captured on any request that carries it — not just the product page —
with `HttpOnly`, `SameSite=Lax`, `Secure` on https, and a 7-day life, which is the
attribution window the document defines. It is validated as an opaque id (≤128 chars,
no URL or markup characters), so it can never become free text in order meta, and it is
copied onto the order at `woocommerce_checkout_create_order` — which is what the poll
actually reads.

What is sent, and nothing else: `purchase_timestamp`, `last_updated_timestamp`,
`torob_clid`, `status`, and optionally `psp`, `order_value`, `shipping_amount`,
`phone_number`, `products`. Three refusals matter here:

- an order **without** a click id is never sent — the documents require the endpoint to
  expose only referred purchases;
- an **unknown** status is dropped rather than guessed: the vocabulary is closed to
  `completed`/`cancelled`, and WooCommerce's cancelled/refunded/failed map to
  `cancelled`, everything else to `completed`;
- a record at or **before** the `*_gt` watermark is not repeated, and a batch is sorted
  ascending, because the poller resumes from the last timestamp it saw.

`limit` is required and bounded at 1 000: a caller asking for 5 000 gets `400`, not a
silently trimmed 1 000 that would look like a complete window. Money is an integer in
Toman, passed through `pos_connector_torob_amount` so a store priced in Rial divides by
ten instead of reporting a hundredfold sale.

`/torob/v1/actions` answers an honest empty list: this platform has no action events of
its own, so a site that tracks them supplies them through `pos_connector_torob_actions`.
An invented record would be worse than none — Torob bills against these.

The switch lives in the plugin's own «ترب» screen, with the copy stating exactly what is
shared, and `uninstall.php` deletes both options so a reinstall never arrives with
consent already granted. `wordpress-plugin/tests/connector-torob-attribution.php` pins
all of it under plain `php` (real Ed25519 keys, no WordPress): the defaults, the 403,
every token failure, the parameter bounds, and each dropped record.

## 7. What remains (Waves 3–6)

1. **Wave 3 — serving the feed.** *The platform half is done*: `§6b` above is live at
   `/api/v1/torob/products/<shopId>` with `auth.ts` verifying Torob's EdDSA token, `product-api.ts`
   owning the order of operations, and `§6c` closing the partner path from `pending_approval` to
   `authorized`. What remains in this wave is the *other* two deployables the issue names — the
   WordPress connector release and the CMS runtime release that serve the same contract from the
   shop's own origin, which is needed wherever the platform does not terminate that shop's domain
   (the token's `aud` is the domain, by design).
2. **Variant catalogue.** The builder already accepts variants and emits one item each; the database
   source reads `menu_items` only, so retail `items`/`item_variant_attributes` products need their
   price source mapped before they can appear.
3. **Wave 4 — the per-shop screen.** *Done*: `§6d` above is `/growth/torob/[shopId]`, with the
   publication rule, the per-product decisions and the blocked products' reasons, and `§6e` adds what
   Torob itself reports about the shop and each page. What is left of this wave is the variant
   catalogue (item 2) and the multi-shop overview columns for Torob's own counts (item 6).
4. **Wave 5 — opt-in attribution.** *Done on the store's origin*: §6h serves
   `/torob/v1/orders` and `/torob/v1/actions` with both switches off by default, `403` when they
   are off, and the switch's own copy saying what is shared. What remains is the platform-side
   variant for shops whose origin the platform terminates — that needs an order store here, which
   the platform does not have today.
5. **Wave 5b — the sync queue.** *Done*: `§6f` is the webhook outbox, bounded and coalesced, with
   dead letters, retries, reconciliation-by-fill and a per-shop queue screen. What is left of this wave
   is closed by §6g: the Shop API's **activate/deactivate** (turning a page off on Torob from here)
   and the per-shop «تعمیر» action that fills, sends and re-reads in one step.
6. **Wave 6 — the drill table and the docs** for the failure classes the issue names (expired token,
   rejected domain, feed refused, shop deleted on Torob's side), plus the runbook for a shop whose
   feed has been `blocked` for longer than an hour, and for a shop whose last Shop API read failed three
   times in a row.

Nothing in Waves 2–6 may re-derive eligibility: `resolveTorobWebsites` is the single answer to "may
this website enroll", and every later surface reads it.

## 8. Where the code is

- `migrations/0278_torob_managed_shops.sql` — the table, its constraints and the tenant RLS policy.
- `src/lib/torob/eligibility.ts` — the pure resolver: candidates in, one state per website out.
- `src/lib/torob/shop-service.ts` — the registries, the shop lifecycle and the credential.
- `src/app/api/growth/torob/shops/route.ts` — one endpoint, five actions, two permissions.
- `src/lib/torob/currency.ts` — Rial → integer Toman, exact or refused.
- `src/lib/torob/feed.ts` — the feed builder: identity, order, skips, paging, envelope.
- `src/lib/torob/feed-service.ts` — the catalogue read and the run record.
- `src/lib/torob/contract.ts` — the Product API v3 request/response contract, and its strict parser.
- `src/lib/torob/auth.ts` — EdDSA verification of `X-Torob-Token`, audience against the shop's domain.
- `src/lib/torob/product-api.ts` — the public endpoint's order of operations and its response codes.
- `src/lib/torob/shop-generator.ts` — Torob's Shop Generator API: request, confirm, read, disconnect.
- `src/lib/torob/authorization-service.ts` — the four-state machine, the 15-minute window, the row.
- `src/app/api/growth/torob/authorize/callback/route.ts` — where Torob returns the merchant's browser.
- `src/app/api/v1/torob/products/[shopId]/route.ts` — the public route itself.
- `src/app/api/growth/torob/shops/[id]/feed/route.ts` — «پیش‌نمایش فید».
- `src/lib/torob/publication.ts` — the two rules, the decision cycle, the page's shared shapes and copy.
- `src/lib/torob/shop-publication.ts` — the per-shop read (why each product is or is not in the feed)
  and the writes, with the catalogue-ownership check.
- `src/app/api/growth/torob/shops/[id]/publication/route.ts` — that page's read and write.
- `src/app/(app)/growth/torob/[shopId]/page.tsx` + `torob-shop-detail.tsx` — the screen.
- `migrations/0282_torob_shop_products.sql` — one decision per product per shop, RLS included.
- `src/lib/torob/observed-state.ts` — Torob's own vocabulary: shop and product statuses, failure codes,
  the three stages, and the summary's arithmetic. Pure, so the client component can render it.
- `src/lib/torob/shop-api-client.ts` — the Shop API: throttled requests, `Retry-After`, cursor-only
  pagination, and strict validation of everything Torob sends back.
- `src/lib/torob/status-service.ts` — when a shop may be read, which credential reads it, and what a
  success or a failure does to the stored snapshot; `torob_status_runs` is the attempt history.
- `src/app/api/growth/torob/shops/[id]/status/route.ts` — the cached read and the explicit refresh.
- `migrations/0283_torob_observations.sql` — the observation columns, `torob_product_states` and
  `torob_status_runs`, RLS included.
- `src/lib/torob/shop-api-client.ts`'s `setTorobPagesActive` + `status-service.ts`'s `setPagesOnTorob`
  and `repairShop` — the Torob-side switch and the one-step repair (§6g).
- `src/app/api/growth/torob/shops/[id]/pages/route.ts` and `.../repair/route.ts` — their two surfaces.
- `integration/torob-pages.integration.test.ts` — the guard (off, unauthorized, no credential, another
  tenant), the per-id answer, the snapshot that is left alone, and «تعمیر»'s order.
- `wordpress-plugin/pos-accounting-connector/includes/class-pos-torob.php` — attribution on the
  store's origin (§6h): the two switches, the 403, token verification, parameter bounds, click
  capture, and the two REST routes.
- `wordpress-plugin/tests/connector-torob-attribution.php` — all of the above under plain `php`.
- `src/lib/torob/webhook.ts` — the webhook's rules: batching, the one-domain check, the two-field
  payload, and what each failure deserves. Pure.
- `src/lib/torob/webhook-client.ts` — the one `POST`, and the mapping from Torob's statuses to the
  queue's closed vocabulary.
- `src/lib/torob/webhook-service.ts` — fill (from the built feed), drain (claim, send, settle), the
  queue read, retry, and the minute tick `server.ts` schedules.
- `src/app/api/growth/torob/shops/[id]/webhook/route.ts` — the queue and its two actions.
- `migrations/0284_torob_webhook_outbox.sql` — the coalesced outbox and the batch log, RLS included.
- `src/app/(app)/growth/torob/page.tsx` + `torob-section.tsx` — the screen.
- `src/lib/torob/eligibility.test.ts` — the state matrix; `integration/torob-shops.integration.test.ts`
  — the lifecycle and the tenant boundary against real Postgres.
- `src/lib/torob/contract.test.ts`, `feed.test.ts`, `auth.test.ts`, `product-api.test.ts`,
  `shop-generator.test.ts`, `authorization-service.test.ts`, `publication.test.ts`,
  `observed-state.test.ts`, `shop-api-client.test.ts`, `webhook.test.ts`, `webhook-client.test.ts` — the
  contract, the builder, the token and the endpoint's order of operations; `integration/torob-api.integration.test.ts`
  — all four request modes, 100 per page, the withdrawn product and the cross-shop audience refusal
  against real Postgres; `integration/torob-authorization.integration.test.ts` — the approval flow,
  the window, the denial and the schema's own invariants; `integration/torob-status.integration.test.ts`
  — the snapshot, the truncated scan, the kept failure and the shops that are never read;
  `integration/torob-webhook.integration.test.ts` — the coalesced queue, the excluded page, the accepted
  batch, the dead letter and the channel that must not send.
