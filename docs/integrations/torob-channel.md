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
   publication rule, the per-product decisions and the blocked products' reasons. What is left of this
   wave is only what the variant catalogue (item 2) unlocks: a retail shop choosing between variants.
4. **Wave 5 — opt-in attribution**: Torob order/action attribution off by default, a 403 when it is
   disabled, and a tenant-visible switch that says exactly what is shared.
5. **Wave 6 — the drill table and the docs** for the failure classes the issue names (expired token,
   rejected domain, feed refused, shop deleted on Torob's side), plus the runbook for a shop whose
   feed has been `blocked` for longer than an hour.

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
- `src/app/(app)/growth/torob/page.tsx` + `torob-section.tsx` — the screen.
- `src/lib/torob/eligibility.test.ts` — the state matrix; `integration/torob-shops.integration.test.ts`
  — the lifecycle and the tenant boundary against real Postgres.
- `src/lib/torob/contract.test.ts`, `feed.test.ts`, `auth.test.ts`, `product-api.test.ts`,
  `shop-generator.test.ts`, `authorization-service.test.ts`, `publication.test.ts` — the
  contract, the builder, the token and the endpoint's order of operations; `integration/torob-api.integration.test.ts`
  — all four request modes, 100 per page, the withdrawn product and the cross-shop audience refusal
  against real Postgres; `integration/torob-authorization.integration.test.ts` — the approval flow,
  the window, the denial and the schema's own invariants.
