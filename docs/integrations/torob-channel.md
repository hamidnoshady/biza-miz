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

## 7. What remains (Waves 3–6)

1. **Wave 3 — serving the feed.** *The platform half is done*: `§6b` above is live at
   `/api/v1/torob/products/<shopId>` with `auth.ts` verifying Torob's EdDSA token and
   `product-api.ts` owning the order of operations. What remains in this wave is the *other* two
   deployables the issue names — the WordPress connector release and the CMS runtime release that
   serve the same contract from the shop's own origin (needed for shops whose domain the platform
   does not terminate, since the token's `aud` is that domain), and the Shop Generator partner path
   that turns `pending_approval` into `authorized` with a `provider_shop_id` and its 15-minute
   callback.
2. **Variant catalogue.** The builder already accepts variants and emits one item each; the database
   source reads `menu_items` only, so retail `items`/`item_variant_attributes` products need their
   price source mapped before they can appear.
3. **Wave 4 — the per-shop screen** (`/growth/torob/[shopId]`): the feed's pages, the skipped
   products with links to fix them, and the publication rule — now that there is enough to put on it.
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
- `src/app/api/v1/torob/products/[shopId]/route.ts` — the public route itself.
- `src/app/api/growth/torob/shops/[id]/feed/route.ts` — «پیش‌نمایش فید».
- `src/app/(app)/growth/torob/page.tsx` + `torob-section.tsx` — the screen.
- `src/lib/torob/eligibility.test.ts` — the state matrix; `integration/torob-shops.integration.test.ts`
  — the lifecycle and the tenant boundary against real Postgres.
- `src/lib/torob/contract.test.ts`, `feed.test.ts`, `auth.test.ts`, `product-api.test.ts` — the
  contract, the builder, the token and the endpoint's order of operations; `integration/torob-api.integration.test.ts`
  — all four request modes, 100 per page, the withdrawn product and the cross-shop audience refusal
  against real Postgres.
