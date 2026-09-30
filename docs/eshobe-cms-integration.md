# Eshobe CMS integration — connecting `cafe-restaurant-pos` to `eshobe-cms` over the API

This app (the Eshobe SaaS platform: POS, accounting, CRM) and
[`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms) (the Payload 3
multi-tenant website platform) are **separate deployments**. This document is
the contract between them and the setup steps for both sides.

## 1. The architecture: headless via REST, tenant from a credential

The CMS resolves the tenant **server-side** from a per-site API key (`Host`
header alone is only valid for anonymous reads on the customer's own domain —
see WAVE-9 §1/§6 in eshobe-cms). An external app never names a tenant in a
query filter.

```
┌─────────────────────────┐          REST + Bearer key          ┌──────────────────────────┐
│  cafe-restaurant-pos     │  ─────────────────────────────────► │  eshobe-cms (Payload 3)   │
│  (POS / accounting /     │   GET  /api/site, /api/pages,       │  one deployment hosts     │
│   CRM — per-business)    │   /api/products, /api/orders …      │  many customer sites      │
│                          │   POST /api/provision-site          │  (per-site domains)       │
└─────────────────────────┘  ◄─────────────────────────────────  └──────────────────────────┘
              ▲   POST /api/cms/revalidate (HMAC-signed) on publish
              └─────────────────────────────────────────────────────┘
```

**Why not embed the CMS in this app?** It is already deployed, multi-tenant,
and ships its own admin. Embedding would duplicate infrastructure, couple
uptime, and re-open the tenant-isolation problem the CMS solved in Wave 9.
The API is the designed interface (WAVE-9.md: "attach by API, or mount the
runtime wholesale").

### Credentials (two kinds, two purposes)

| Key | Role | Issued by | Used for |
|---|---|---|---|
| Site key | `site` | `POST /api/api-keys/issue {siteId, name, role:"site"}` | That one site: pages, posts, products, categories, media, orders (status changes only). Reads include drafts (it is the builder's editor token). |
| Platform key | `platform` | issue endpoint, `{role:"platform"}` | Provisioning, key lifecycle, and (since migration 0139) the whole operator surface `/api/platform/*` — the fleet report, a site's lifecycle, and content snapshots in both directions. It is the **deployment's root credential**; §7.2 explains why the old "cannot read site content" line was a shape rather than a boundary. |

Both are stored hashed on the CMS (`keyHash` — sha256, never the raw key);
the raw key is shown once at issue time, same pattern as this app's WooCommerce
plugin token.

The POS side stores per-business site keys **encrypted at rest**
(`eshobe_cms_connections`, AES-256-GCM via `src/lib/integrations/secrets.ts`)
and only ever decrypts them inside the outbound HTTP client.

## 2. This repo (the builder side) — what was added

| File | Purpose |
|---|---|
| `src/lib/cms/client.ts` | The only HTTP client for the CMS. Pure URL/header/error core (unit-tested), typed helpers for every endpoint the builder needs (`fetchSiteDescriptor`, `fetchPages/Posts/Products`, `provisionSite`, `issueSiteApiKey`, …). |
| `src/lib/cms/types.ts` | Curated Payload shapes (Site, Page, Post, Product, Order, Media, …). |
| `src/lib/cms/config.ts` | Env contract; `src/lib/cms/connections.ts` resolves the per-business config (domain + decrypted key). |
| `src/lib/cms/webhook.ts` | HMAC verification (`x-eshobe-signature: sha256=<hex>`) + cache-tag derivation. |
| `src/app/api/cms/revalidate/route.ts` | The receiver: verifies the CMS's publish webhook and purges cached CMS data by site tag. |
| `migrations/0122_eshobe_cms_connection.sql` | `eshobe_cms_connections` — one row per business, tenant RLS. |
| `src/lib/website/setup.ts` / `setup-service.ts` | The four-step site-building wizard: the pure step rules (unit-tested) and the `website_setup` row they read and write. |
| `src/lib/website/domain-service.ts` | Buying a domain: price it, refuse early on an empty wallet, order through the CMS's registrar, then bill it here. |
| `src/lib/website/billing.ts` / `billing-service.ts` | What a platform site costs and when the next period falls due; the plan catalogue, the subscription and every charge, settled against the platform wallet. |
| `src/lib/website/managers-service.ts` | Which of the app's two managers this business actually has — one cheap local read the sidebar and the app home both build themselves from. |
| `migrations/0138_website_management.sql` | `website_setup`, `website_service_plans` (global) and the tenant-RLS'd `website_service_subscriptions` / `website_service_charges`; also merges the `wp` app-availability rows into `website`. |

### Environment variables (`cp .env.example .env` / `.env.local.example`)

```
ESHOBE_CMS_URL=https://cms.eshobe.com        # control-plane origin, no trailing slash
ESHOBE_CMS_WEBHOOK_SECRET=<CMS PAYLOAD_SECRET>
ESHOBE_CMS_PLATFORM_API_KEY=                 # optional platform key (provisioning)
```

## 3. Deploying the CMS so the builder can attach

(One-time operator steps in the eshobe-cms repo/deployment.)

1. **DNS**: customer domains → the CMS server; `cms.eshobe.com` (or whatever
   the control plane is) → the CMS. Caddy (in the eshobe-cms repo) serves
   customer domains and the control plane from one deployment, and blocks
   `/api/*` on customer domains by default. This app's client (`src/lib/cms/client.ts`)
   forwards the site's own domain as `Host` on every call, even when the URL it
   dials is the control-plane origin — Caddy's HTTP routing keys on `Host`, not
   on the TLS SNI a `fetch()` negotiates, so a site-scoped call lands on the
   *customer-domain* block regardless of which origin it was dialed through. The
   `@cms_content` carve-out in the CMS's Caddyfile is what lets it through there;
   the application's own access layer (`src/access/siteApiKey.ts`,
   `src/access/siteRead.ts` on the CMS side) is the real boundary, the same trust
   split `/api/site`'s pre-existing carve-out already made. Platform-level calls
   (`provisionSite`, `issueSiteApiKey`, …) carry no `siteDomain`, so they keep
   `Host` as the control plane's own name and need no carve-out at all.
2. **API keys (CMS side)**: the WAVE-9 §9.4 feature is delivered by
   `eshobe-cms-api-keys.patch` (see §6). After applying it:
   - `pnpm install && pnpm generate:types && pnpm typecheck && pnpm test:int`
   - Issue keys: `POST /api/api-keys/issue` (platform-admin session or a
     platform key).
3. **Revalidation webhook**: on the CMS set
   `REVALIDATE_WEBHOOK_URL=https://<this-app>/api/cms/revalidate`.
   The secret it signs with is the CMS's `PAYLOAD_SECRET` — put the **same
   value** in `ESHOBE_CMS_WEBHOOK_SECRET` here.
4. **CORS**: not needed for server-to-server calls (CORS is browser-only).
   Leave `API_CORS_ORIGINS` unchanged unless a browser client is added.

## 4. Using the connection from app code

```ts
import { getCmsConfigForBusiness } from "@/lib/cms/connections";
import { fetchSiteDescriptor, fetchProducts, updateOrderStatus } from "@/lib/cms/client";

// Inside a request scoped to a business (RLS is already applied by the pool):
const cms = await getCmsConfigForBusiness(businessId);   // throws if not connected
const site = await fetchSiteDescriptor(cms);             // theme, locales, store
const products = await fetchProducts(cms);               // the site's catalogue
await updateOrderStatus(cms, orderId, "paid");           // e-commerce ops
```

- **Never** pass `where[site][equals]` to choose a tenant — the key does it.
- Prices are integers in the site's minor currency unit — format with the
  site's currency, never convert Toman↔Rial client-side.
- Media URLs: `absoluteCmsMediaUrl(media, site.media.origin)` — the stored
  `url` is often relative and must resolve against the *site's* origin.
- All calls are server-side; never put a raw site key in a browser bundle.

### Connecting a business (flow)

The wizard's `POST /api/cms/website/setup/build` runs these steps (and then
starts the subscription); an existing site is attached with
`POST /api/cms/website/connect` instead.

1. Provision the website for the business: `provisionSite(platformConfig, input)`
   (platform key) → returns `site.id`, `site.domain`, `site.url`.
2. Issue its site key: `issueSiteApiKey(platformConfig, { siteId, role: "site" })`
   → raw key returned once.
3. Store both: `saveCmsConnection({ businessId, siteId, siteDomain, baseUrl, apiKey, keyName })`.
4. From then on everything uses `getCmsConfigForBusiness(businessId)`.

## 5. «مدیریت وب‌سایت» — one app, two managers

The owner/manager surface is **one app** (`/dashboard/website`, «مدیریت
وب‌سایت», `src/lib/apps.ts`) with two managers inside it, and the distinction
matters in both directions:

* **سایت‌ساز اشوبه** (`/dashboard/website/cms/*`) — this document's subject: the
  platform site, on eshobe-cms.
* **وردپرس و ووکامرس** (`/dashboard/website/wp/*`) — a WordPress site the
  business already runs (Phase 40; it moved here from `/dashboard/wp`, which
  now redirects).

They are peers and never fold into each other: separate connections, separate
sections, separate headers. What they share is one door in the rail and one
sidebar, whose menu is built from the business's **real connections**
(`GET /api/website/managers`) — a manager with no connection lists only its
front page and the screen that connects it, so there is never a «سفارش‌ها»
entry over a site that does not exist.

The `integrations` entitlement gates the WordPress half only
(`/dashboard/website/wp` in `features.ts`): a business without the add-on
still reaches the platform site it pays for.

### The CMS manager's sections

| Section | Route | What it is |
|---|---|---|
| میز کار سایت | `/dashboard/website/cms` | Connection, the DNS checklist and the live preview. |
| ساخت سایت | `…/cms/setup` | The four-step wizard (below). |
| محتوا | `…/cms/content` | The site's pages and posts. |
| فروشگاه | `…/cms/store` | Products and the orders the site took. |
| تنظیمات و همگام‌سازی | `…/cms/settings` | The connection itself, and the one-way price/stock push (Phase 38w; this section is where the connections hub's «وب‌سایت» tab moved). |
| اشتراک و صورت‌حساب | `…/cms/billing` | What the site costs and what it has cost. |

### Building a site: domain → CDN → type → build

«سایت‌ساز کار سایت را می‌کند؛ پول را این‌جا می‌گیریم.» The wizard
(`src/lib/website/setup.ts`, `website_setup`) walks the four steps in the order
an owner works in, saving each answer as it is given so it can be abandoned on
a phone and finished on a desk. Which step is "current" is never stored twice —
it is derived from the answers.

1. **دامنه.** Either the business owns the domain and will point DNS at the
   platform, or the platform's registrar registers it. A quote
   (`GET /api/cms/website/domain/quote`) has no side effects and needs no site,
   which is why it can be asked at step one — the CMS accepts a *platform* key
   for the quote alone. An order (`POST …/domain/order`) is site-key work and
   is priced, wallet-checked, placed and *then* billed, in that order: charging
   first would need a refund path that only runs on failure.
2. **CDN.** ArvanCloud in front of the site, or a recorded «بدون CDN» — saying
   no is a decision the wizard keeps, not a step it drops. Creating the zone is
   platform-staff work on the CMS; the business sees its own zone through
   `GET /api/cms/website/cdn` and can empty its own cache.
3. **نوع سایت.** معرفی کسب‌وکار / نمونه‌کار / فروشگاه, plus a name and the plan
   the site will run on. This is what `POST /api/provision-site` is told, so it
   decides the new site's blocks and starter content.
4. **ساخت.** Provision on the CMS → issue the site key → store it encrypted →
   start the subscription, in that order. A business is never billed for a site
   whose provisioning failed; the reverse (a site with nothing billing for it)
   is recoverable by the operator, so that is the direction the failure falls.

### Who bills for the site

The CMS renders and serves; it has no wallet, no plan and no invoice. Every
Rial — the monthly site fee, a domain registration or renewal, a one-off setup
— is a `website_service_charges` row settled against the **same platform wallet**
the assistant and messaging draw on (migration 0130), so one top-up covers all
three. Two rules carry it:

* **Idempotency is the UNIQUE index** `(business_id, kind, reference)`. A
  subscription charge's reference is the period it covers, never the moment the
  tick ran, so a retry or a second replica cannot bill twice.
* **A wallet that cannot cover a renewal marks the subscription `past_due` and
  leaves the site serving.** `runWebsiteBillingTick()` (hourly, on the custom
  server) never cuts a shopfront off; the owner sees the state and a
  «پرداخت دورهٔ جاری» button on the billing section.

A quote in a currency this app cannot express in Rial is **refused** rather than
converted at a guessed rate (`quoteToRial`): charging a business a number nobody
can reconcile is worse than saying the platform cannot sell that TLD yet.

### The API surface

| Route | What it does |
|---|---|
| `GET /api/cms/website/state` | Masked connection state (never the key). |
| `POST /api/cms/website/connect` | Attach an existing site (probe descriptor → store key encrypted). |
| `DELETE /api/cms/website/connection` | Disconnect (the CMS site and its content remain). |
| `GET /api/cms/website/overview` | Descriptor + pages + posts + products + orders (private, 30s SWR). |
| `GET /api/cms/website/dns` | DNS checklist state: does the domain resolve to the CMS (A/AAAA from here) + descriptor `domainVerified`. |
| `GET`/`POST /api/cms/website/drafts`, `PATCH /api/cms/website/drafts/[id]` | List, create and edit posts (the `website.post.draft`/`update` actions the assistant shares). Always lands as a draft — a site key can never publish over the API. |
| `DELETE /api/cms/website/posts/[id]` | Delete a post. |
| `POST /api/cms/website/products`, `PATCH`/`DELETE /api/cms/website/products/[id]` | Create/edit/delete a product. Same draft-only rule. |
| `GET /api/cms/website/pages` | The site's pages, drafts included. Read-only: the CMS refuses a page write from a site key. |
| `POST /api/cms/website/{drafts,pages,products}/[id]/publish` | Publish one draft. The site key cannot publish, so this goes through the platform-key owner bridge (`POST /api/platform/sites/:id/publish` on the CMS), behind `cms.publish` — always a person's click. |
| `PATCH /api/cms/website/domain` | Move the connected site to a new domain (`updateSiteDomain` → CMS `PATCH /api/site/domain`, site-key only). Resets `domainVerified` server-side and updates the stored `site_domain`; the DNS checklist has to be re-run and the CMS-side box re-ticked. |
| `PATCH /api/cms/website/orders/[id]` | Move an order status; the CMS settles stock & snapshot. |
| `GET`/`PATCH /api/cms/website/setup` | The wizard's state (plus the plan catalogue); record one step's answer. |
| `POST /api/cms/website/setup/build` | Step 4 — provision, connect and subscribe. Owner only. |
| `GET /api/cms/website/domain/quote` | Price a domain, with the wallet balance beside it. No side effects, no site required. |
| `POST /api/cms/website/domain/order` | Buy/transfer/renew through the CMS's registrar and bill it here. Owner only. |
| `GET /api/cms/website/domain/registrar` | The domains the platform's registrar holds for this site and the timeline of register/transfer/renew requests (CMS `GET /api/site/registrar/{domains,operations}`). Renewal is `POST …/domain/order` with `operation: "renew"` — priced, wallet-checked, ordered, billed. |
| `GET /api/cms/website/cdn`, `POST …/cdn/purge` | The site's own CDN zone, and emptying its own edge cache. |
| `GET /api/website/managers` | Which of the app's two managers this business has — what the sidebar and the app home are built from. |
| `GET`/`POST /api/website/billing` | Plan, subscription and charges; start/change a plan, pay the current period, stop auto-renewal. |

Pages are listed and published from this app but never written — the block-based page builder is a CMS-admin surface, deliberately not duplicated here (and the CMS refuses a page write from a site key). A new site is created only by the wizard's `setup/build` (provision → connect → subscribe); there is no second provisioning route that could create a site nothing bills for. «مدیریت محتوا در CMS» keeps that door open for anything this screen doesn't cover (page layout, media, nav, forms, publishing).

### DNS checklist + live preview

The Website Manager shows a three-step checklist («دامنه و انتشار سایت»):
1. A/CNAME record for the customer domain exists — checked by resolving the
   domain from this server (the same resolver family browsers use).
2. It points to the CMS server — the resolved addresses overlap the CMS
   origin's addresses (`src/lib/cms/dns.ts`).
3. The operator has ticked **تأیید دامنه** in the CMS admin — read from the
   site descriptor (`domainVerified`, added to `/api/site` by the patch).

Once all three are green, an **in-app iframe preview** of the live site is
shown (`https://{domain}/`). Since the CMS's site pages send
`frame-ancestors 'self' <admin>` CSP, the POS origin must be added on the CMS:

```
# eshobe-cms .env — comma-separated origins allowed to frame customer sites
SITE_PREVIEW_ORIGINS=https://pos.eshobe.com
```

(The patch extends that header from this env var; empty = admin origin only,
the previous behaviour. Note: the CMS's own `/api/domain-check` is
Caddy-internal and answered 404 publicly, so the builder deliberately uses
DNS resolution + `domainVerified` instead of it.)

All owner/manager, all server-side — the browser never sees a CMS key.
On the CMS, the site descriptor (`GET /api/site`) also returns `id` so the
connect flow can record which site the key belongs to.

## 6. The CMS side (WAVE-9 §9.4, `eshobe-cms`)

Landed directly in the `eshobe-cms` repo (not a patch to apply):

- `src/lib/api-keys.ts` — pure key generation/hashing (`eshobe_live_…`, sha256,
  a bearer-token parser). Framework-free, like `src/lib/slug.ts`.
- `src/collections/ApiKeys.ts` — the credential collection (platform-admin
  only; deliberately **not** in the multi-tenant plugin's `collections` map).
  A `beforeValidate` hook mints the key on create and stashes the raw value on
  `req.context` for the issuing endpoint to return exactly once.
- `src/access/siteApiKey.ts` — key resolution (`Bearer eshobe_live_…` → sha256
  lookup → site, memoised per request like `siteRead.ts`'s `Host` lookup) and
  the access wrappers every collection composes: `apiKeyAware` (read — a site
  key sees its own site's drafts too), `apiKeyCreateAware`/`apiKeyUpdateAware`
  (write — site-scoped, never a publish), `platformApiKeyAware` (`sites`'
  own read, `provision-site`), `forceApiKeySite` (a `beforeChange` hook that
  overwrites `data.site` with the key's own site — access only checks a valid
  key exists, this is what stops it naming a *different* site in the payload).
- `src/collections/hooks/restrictApiKeyOrderWrite.ts` — a site key's one order
  write is a status transition; every other field reverts to what the document
  already held.
- `src/endpoints/apiKeys.ts` — `POST /api/api-keys/issue`,
  `GET /api/api-keys/list`, `POST /api/api-keys/revoke` (platform-admin
  session or a platform key).
- Access wiring: `pages` read only (page layout stays a CMS-admin surface —
  see §5 below); `posts` and `products` read/create/update/delete, always
  draft-only on a key-authorized write (`apiKeyCreateAware`/
  `apiKeyUpdateAware` refuse `_status: "published"` — no key can publish);
  `orders` read/update (status only); `sites` read accepts a platform key
  too. `categories`/`media`/`store` needed no change — already host-scoped
  public reads with no draft state, which a site key's forwarded `Host`
  already satisfies.
  **Open gap — media writes.** That covers *reading* media only. The CMS's
  `Media` collection still gates `create`/`update`/`delete` on an admin
  session (`authenticated`), so the «رسانه‌ها» section's upload, alt-text
  edit and delete — and a post's featured-image upload — are refused (403)
  when made with a site key. Closing it is a CMS-side access change
  (`apiKeyCreateAware`/`apiKeyUpdateAware`/`apiKeyAware` around
  `authenticated`, plus `forceApiKeySite` ahead of `setMediaPrefix`, and
  `/api/media` in the Caddy `@cms_content` carve-out), and needs the CMS
  owner's sign-off because it widens what a site key may write.
- `src/endpoints/siteDescriptor.ts` (`GET /api/site`) falls back to a site
  key when `Host` resolves nothing — the case WAVE-9 names explicitly
  ("a builder can call from a non-customer origin"); the fallback response is
  never publicly cached (`cache-control: private, no-store`), unlike the
  `Host`-resolved one. The response's `id` and `domainVerified` fields are
  **only** included on that key-resolved, private response — never on the
  public `Host`-resolved one (`tests/int/headless.int.spec.ts` pins the
  omission), since both are internal to the site's own builder.
- `src/endpoints/updateSiteDomain.ts` (`PATCH /api/site/domain`) — the one
  write path onto `Sites` a credential can reach at all: `Sites.access.update`
  stays `authenticated` (admin-session only) for everything else. Site-key
  only, resets `domainVerified` to `false` on every change, and refuses a
  domain already in use by another site.
- `src/provisioning/provisionSite.ts` and `provisionSiteEndpoint` accept a
  platform key alongside a platform-admin session, at both the endpoint guard
  and the service function's own re-check.
- `Caddyfile` — a `@cms_content` carve-out for `/api/{pages,posts,products,
  categories,store,orders}` on the customer-domain block, and a separate
  `@site_domain` carve-out (`PATCH /api/site/domain` only) for the endpoint
  above. This app's client forwards a site's domain as `Host` even when
  dialing the control-plane origin (see §1 above), which routes there rather
  than to the control-plane block; the application's access layer is the real
  boundary, the same trust split `/api/site`'s pre-existing carve-out already
  made.
- `next.config.ts` — `SITE_PREVIEW_ORIGINS` extends the `frame-ancestors` CSP
  so this app's live-preview iframe (§"DNS checklist + live preview" above) is
  allowed to frame a customer site.

After pulling these changes:

```bash
pnpm install
pnpm generate:types   # adds the ApiKey interface to payload-types.ts
pnpm payload migrate:create add-api-keys   # dev uses push; prod needs the migration
pnpm typecheck && pnpm test:int
```

Security properties this keeps: a key never names a tenant (the payload's
`site` is overwritten on create); a key is confined to one site on reads and
updates; revoking is immediate (`disabledAt`); platform keys cannot read or
write site content; the raw key is never stored and never
returned twice.

## 7. «سایت‌ساز» — the operator's side, in the super-admin console (migration 0139)

> **کارِ مشتری در «مدیریت وب‌سایت» است؛ کارِ سکو در کنسول.** §5 is the business's
> own manager: one owner, one site. This section is its counterpart for the
> *platform operator*: every superadmin function of eshobe-cms and every
> fleet-wide report about it, inside the console that already administers
> businesses, billing, backups and observability — reached from **one CMS address
> and one `role: "platform"` key**.

Before this, an operator administering the website platform opened its own
`/admin` on another host, behind another login, where nothing they did produced a
`platform_audit_log` row here and no cross-site question had an answer at all.
The console's own rule says it plainly: functionality that supervises clients
*across* businesses belongs in `src/app/platform/**`.

### 7.1 What is where

| Page | Route | What it does |
|---|---|---|
| میز فرمان | `/platform/cms` | The fleet report: sites by status and type, verified vs not, content counts, orders, **paid money per currency**, the gateway table, object storage, the jobs queue, and the findings row above it. |
| سایت‌ها | `…/cms/sites` | Every site with its own counts; a panel per site for its lifecycle (suspend/reactivate, rename, type, locales, tick domain verification), its keys (issue/revoke), and provisioning a new site. |
| همگام‌سازی | `…/cms/sync` | Mirror refresh, event poll, and content **pull/push** with a dry run; plus the log of every run. |
| پایش | `…/cms/logs` | The CMS's log tail in OpenObserve (§6.4). |
| اتصال | `…/cms/connection` | The CMS address, the platform key, verification, and the two background switches. |

| Route | What it does |
|---|---|
| `GET`/`PUT`/`POST /api/platform/cms/config` | Read the masked connection, save it, verify it against the CMS. |
| `GET /api/platform/cms/overview` | The live report *and* the mirror, with `overviewError` when the CMS did not answer. |
| `GET`/`POST /api/platform/cms/sites` | The mirrored list; provision a new site (optionally issuing its key). |
| `GET`/`PATCH /api/platform/cms/sites/[id]` | One site live (falling back to the mirror); its lifecycle. |
| `GET`/`POST`/`DELETE /api/platform/cms/keys` | A site's keys: list (masked by the CMS), issue, revoke. |
| `POST /api/platform/cms/sync` | `{ kind: "mirror" \| "events" \| "pull" \| "push" }`. |
| `GET /api/platform/cms/runs` | The sync log. |
| `GET /api/platform/observability?source=cms` | The CMS log stream, through the existing proxy. |

The CMS side is `/api/platform/*` over there — see
[`docs/platform-control-api.md`](https://github.com/hamidnoshady/eshobe-cms/blob/main/docs/platform-control-api.md)
in that repo for the endpoint contract and its own rules.

### 7.2 The credential, and what it now reaches

The address and key live in `platform_cms_config` (a singleton alongside
`platform_message_config`); the key is AES-256-GCM encrypted at rest through
`src/lib/integrations/secrets.ts`. The inactive `platform_update_config` singleton
was removed by migration 0187 and is not part of this integration. Three rules:

* **The key is never returned by anything.** The console reads a masked view whose
  only trace of it is the last four characters. There is no route that returns it.
* **An empty submission means *unchanged*, never *delete*.** The field renders
  empty, so every save posts it empty; «حذف کلید» (`clearApiKey: true`) is the
  explicit door. Treating empty as deletion would wipe the platform's root
  credential for its own website platform the moment somebody fixed a typo in a
  label.
* **`ESHOBE_CMS_URL` / `ESHOBE_CMS_PLATFORM_API_KEY` remain the fallback.**
  `resolvePlatformCmsConfig()` prefers the stored row and falls back to the env
  pair, so a deployment configured before 0139 keeps working and a rotation is a
  form submission rather than a redeploy.

Writes need the new **`cms.manage`** capability (engineer + owner — the same
reasoning as `backup.manage`: keeping the fleet's websites serving is ordinary
operations). Reading the report rides `system.read`, which every role holds:
knowing that four domains are unverified is not privileged information.

§5's rule — *never put a platform key where a site key belongs* — still holds for
site content in the tenant flows. What changed is honest and worth stating: the
platform key now also *reaches* every site's content, through the CMS's snapshot
export. That is not new authority. A platform key could already issue itself a
`role: "site"` key for any site (`/api/api-keys/issue` takes a `siteId`) and read
that site's drafts. The split between the two roles was always a shape, never a
boundary; the boundary is that a *site* key still reaches exactly one site.

### 7.3 The mirror, and why there is one

`platform_cms_sites` is a **cache of somebody else's model**, refreshed by the
tick and by the console's «به‌روزرسانی» button, and stamped with when it was read.
Two reasons it exists: a fleet-wide question answers from one local query instead
of N calls across the network, and the console keeps rendering real figures with
an honest caveat while the CMS restarts — rather than an empty screen with an
error on it. `business_id` is filled by joining this platform's own
`eshobe_cms_connections`, so «whose site is this?» is answered here; the CMS has
no idea who bills for it, and a site nobody here bills for shows as
«بدون کسب‌وکار متصل» — a finding, not an error.

Its delete pass is why the client pages through the *whole* list: a site removed
from the CMS is the one state a pure upsert cannot represent, and a console still
showing a deleted customer's site is worse than one showing none.

### 7.4 Syncing content, both directions

`pull` exports one site's content (`GET …/snapshot` on the CMS) and `push` applies
a snapshot back. Four properties:

* **A push is a dry run first.** The plan («۴ به‌روزرسانی، ۱ ساخت») is shown and
  the apply button appears after it. A count that arrives after the write is not a
  decision.
* **The counts reported are the CMS's own**, from its import plan — a write is
  applied only to the extent the other side says it was.
* **The snapshot is the operator's artefact.** It downloads as JSON and this
  deployment keeps no copy: a second store of every customer's content, with no
  retention policy behind it, is not something to acquire by accident.
* **An import of another site's snapshot is refused** unless `force` is ticked,
  because its relationship values (a hero image, a category) are the source site's
  document ids. Media is not in a snapshot at all — the files are in object storage
  and a JSON document that listed them without their bytes would read as a backup.

Every run — mirror, events, pull, push — writes a `platform_cms_sync_runs` row with
what it touched and how long it took, success or failure. A content restore nobody
can point at afterwards is an incident, not an operation.

### 7.5 OpenObserve: the CMS's own logs, here

`docs/openobserve.md` made *this* deployment observable. The CMS is a second
deployment whose `console.error` lives for one container's lifetime, whose jobs
queue stopping is silent, and whose failed gateway self-test is a row nobody
queries. Two producers now fill a dedicated stream (`OPENOBSERVE_CMS_STREAM`,
default `cms_events`) with **no collector credential on the CMS at all**:

1. **Every control call this console makes** — operation, outcome, latency and
   failure class (`src/lib/cms/platform-client.ts` wraps each one). A network error
   is `error` and an API refusal is `warn`, deliberately: a CMS that refused
   answered, and a CMS that did not answer is the outage.
2. **The CMS's own event feed** — `GET /api/platform/events` polled on a cursor by
   the tick: site changes, unverified domains, orders, gateway self-tests, keys
   issued. Each record keeps the CMS's `id` (so a duplicate from an overlapping
   poll is findable) and its own `source_at` (so a feed polled every ten minutes
   does not show every record as having happened at poll time).

The cursor advances to **the newest record actually received**, never to `now` — a
CMS row written while the poll was in flight must still be reachable next time.
Both halves are opt-in and default off, so a deployment with no CMS makes no
network call because a migration ran.

## 8. Store orders → accounting (Phase G)

Paid CMS store checkouts import into platform accounting (one `orders` row per CMS
order id). Wire contract: `cms-store-order-contract/v1/`. Production deployer
checklist: `cms-store-orders-production-ops.md` in the platform project store.

| Piece | Where |
|---|---|
| Inbox + idempotency | `cms_store_order_inbox` — unique `(cms_connection_id, delivery_id)` and `(cms_connection_id, cms_order_id)` |
| HTTP ingest | `POST /api/cms/order-events` — HMAC like revalidate (`ESHOBE_CMS_WEBHOOK_SECRET`); body `siteId`, `deliveryId`, `event: "order.paid"`, full `order` |
| Poll fallback | `runCmsStoreOrderPollTick` (60s) — `GET /api/platform/events`, cursor `platform_cms_config.store_order_ingest_cursor`, then `fetchOrderById` with the site key |
| Site map | `eshobe_cms_connections.site_id` |
| Product lines / COGS | `website_product_map` (`remote_id` = CMS product id, `sync_enabled`) |
| UI status | CMS manager **فروشگاه** — `inboxStatusForCmsOrders` |

CMS emits `order.paid` on the platform event feed and audit log when checkout
status becomes `paid` (`emitOrderPaid`). Standard CMS **webhooks** use
`<timestamp>.<body>` signatures and the platform event JSON shape — they do
**not** substitute for `order-events` without a translator. Production default:
platform poll + site key fetch.

Refund/cancel-after-import is not part of Phase G; no `order.refunded` ingest yet.

## 9. Failure handling

- The client throws `CmsApiError` (HTTP 4xx/5xx with the Payload error body)
  or `CmsNetworkError` (timeout/DNS — default 8s timeout).
- Reads are best-effort by design: a down CMS never takes the POS down.
  Callers should fall back to cached/last-known data (the webhook + cache
  tags make staleness bounded), and a **write** must never be reported as
  applied unless the CMS answered 2xx.
- Webhook verification failure returns 401 and purges nothing — an
  unauthenticated cache purge is a DoS button.
