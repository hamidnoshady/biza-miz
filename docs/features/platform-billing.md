# Platform billing — wallet credits, plan builder & online payments

The super-admin platform has its own payment system: every important,
meterable function spends from a per-business **wallet** of credit, credits are
bought by top-up through an Iranian payment gateway (**Zarinpal**), and the
super-admin builds **plans** by picking functions and giving each a cost —
including *free for a limited time* or *free for a limited number of uses*.

All money is stored as **integer Rial**. The UI displays Toman.

## What the super-admin controls

Two new console entries (super-admin sidebar):

- **پرداخت‌ها** (`/platform/billing`)
  - Gateway settings — Zarinpal merchant ID, sandbox/live toggle, callback URL,
    manual (bank-transfer) fallback.
  - Credit **packages** (name / price / credit granted — credit can exceed price
    for a bonus), activate/deactivate/delete.
  - Every payment across businesses, filterable by status, with **تأیید / رد**
    buttons for manual-gateway payments.
- **پلن‌ساز** (`/platform/plans`) — the plan builder:
  - Create billing plans (name + optional monthly base fee).
  - For each plan, **add functions (feature flags)** and choose a cost model:
    - `included` — part of the plan, no extra charge.
    - `monthly` — a fixed monthly add-on fee.
    - `per_use` — **metered**: each use costs `price` from the business wallet.
    - `addon` — one-off purchase the business then owns.
  - Optional promotion on a metered function:
    - **free until a date** (`free_until`) — limited time, and/or
    - **free for N uses** (`free_limit`) — limited use.

Each business also gets a **کیف پول و پرداخت** tab in its console workspace
(`/platform/businesses/{id}/billing`) showing balance, ledger, entitlements,
per-feature usage and payments, with manual grant/deduct controls.

## What the business sees

- A **small credit badge** (coin icon + balance in Toman) in the dashboard
  chrome on every page — desktop sidebar header and the mobile header. It polls
  `/api/billing/wallet` and links to the billing page.
- **اعتبار و پرداخت‌ها** (`/settings/billing` — legacy `/dashboard/billing` redirects with 308, owner/manager): balance,
  top-up packages, custom-amount top-up, plans, and payment history.
- Top-up redirects to Zarinpal; Zarinpal returns to the configured callback,
  the page verifies the payment, and the wallet is credited.

## Payment flow (Zarinpal)

1. Business picks a package → `POST /api/billing/payments` creates a
   `billing_payments` row (`pending`) and calls Zarinpal `payment/request.json`.
2. The row moves to `redirect` with the gateway **authority**; the browser is
   sent to `https://payment.zarinpal.com/pg/StartPay/{authority}`
   (or `sandbox.zarinpal.com` when sandbox is on).
3. Zarinpal returns the browser to the canonical callback `callback_url?payment=<id>&Authority=…&Status=OK|NOK` — the canonical handler is `/api/billing/payments/callback`, which validates HTTPS and tenant context and redirects to the browser (legacy tenant path `/api/billing/payments/callback` under the billing route tree is not shipped; use the supported canonical mechanism).
4. The return page calls `POST /api/billing/payments/verify` (or the unauthenticated callback handler verifies server-side), which calls, which calls
   Zarinpal `payment/verify.json`; on code 100/101 the payment is **settled**
   (wallet credited + ledger entry) exactly once.

Gateway configuration lives in the `platform_payment_config` singleton and is
edited on `/platform/billing`. With gateway = `manual`, payments are created
and then approved/rejected by an admin (bank-transfer flow).

## How a function bills a use

Server code for a metered function calls one helper **before doing the work**:

```ts
import { chargeForFeature } from "@/lib/billing-guard";

const gate = await chargeForFeature(businessId, "backup", { note: "…", userId });
if (!gate.ok) return gate.response;   // 402 no credits / 403 not entitled
```

- Not entitled at all → `403 feature_not_entitled`.
- Entitled but wallet too low → `402 insufficient_credits` (with `topUpUrl`).
- A free promo or a zero price proceeds without a debit.
- A capability declared in `src/lib/billing/catalog/declarations.ts` is never
  implicitly free. A route or `chargeForFeature` key with no declaration fails
  the billing catalogue test. A key that predates that registry and is still
  undeclared keeps the historical flag-governed path.

`/api/backup/run` is wired as the reference integration.

## Data model (migration 0130)

| Table | Tenant? | Purpose |
| --- | --- | --- |
| `platform_payment_config` | global | Gateway singleton (merchant id, sandbox, callback) |
| `credit_packages` | global | Top-up package catalogue |
| `billing_plans` / `billing_plan_features` | global | Plan builder: per-plan, per-feature price model + promo |
| `business_wallets` | tenant (RLS) | Balance + lifetime totals |
| `wallet_ledger` | tenant (RLS) | Every credit/debit, row-locked, exactly-once per payment |
| `billing_payments` | tenant (RLS) | Top-up / plan / add-on payment transactions |
| `business_entitlements` | tenant (RLS) | Owned features (plan/addon/promo/manual) + expiry |
| `feature_usage` | tenant (RLS) | Per-feature use/charge counters (drives free-use quotas) |

All business-owned tables use `FORCE ROW LEVEL SECURITY` with the same tenant
policy as the rest of the platform (`app_rls_bypass() OR business_id =
app_current_business()`), so they pass the tenant-isolation test.

## Configuration

Gateway settings are stored in the database (edited in the console), so no
deployment env vars are required beyond the existing `DATABASE_URL` and
`JWT_SECRET`. Set the **callback URL** to the public `/settings/billing` via the canonical callback `/api/billing/payments/callback`
address of the deployment (e.g. `https://app.example.com/api/billing/payments/callback`), maintaining the legacy redirect `/dashboard/billing` → `/settings/billing`,
turn **sandbox off** for live payments, and paste the Zarinpal merchant ID.

## One commercial system (migration 0177)

`cafe-restaurant-pos` is the commercial authority. Customer price, wallet
balance, subscription state and invoices are decided here. eshobe-cms may
report a quantity of a known meter for a site; this app resolves that site to
a business and rates the event. The CMS does not send a Rial amount and does
not name the business.

The domains are:

- plan catalogue: `billing_plans`
- capability declarations: `src/lib/billing/catalog/declarations.ts` (CI fails when a route segment or `chargeForFeature` key is undeclared)
- meters: `billing_meters` and `src/lib/billing/catalog/meters.ts`
- allowances: `billing_plan_meter_allowances`
- usage ledger: `billing_usage_events` (append-only; daily rollups are derived)
- prices: `billing_price_versions`
- wallet: `business_wallets` / `wallet_ledger`
- subscriptions and invoices: `business_subscriptions`, `billing_invoices`
- spend policy: `business_spend_policies`
- vendor cost: `billing_vendor_cost_events`

CMS usage is `POST /api/internal/billing/usage/v1/batch`, signed with a
credential whose only scope is `billing.usage.write`.

### Compatibility that remains

These are history or mirrors. They are not a second commercial authority:

- `message_credit_ledger` — historical rows. New message reserves, settlements and top-ups write `wallet_ledger`. Migration 0177 copies a positive balance into the wallet once.
- `website_service_plans`, `website_service_subscriptions`, `website_service_charges` — the site's operational plan and the idempotency claim. Money is the platform wallet plus a `billing_invoices` row. A failed charge leaves that invoice open.
- `platform_media_config` price columns — a mirror. Saving the tariff also publishes `billing_price_versions`. The daily charge amount still follows the existing flat plus per-GiB formula so historical invoices stay reconcilable, and each day also appends `media.storage_byte_hour`.
- `billing_plans.monthly_ai_credit_rial` — a mirror of the `ai.credit` allowance. Readers use the allowance row when it exists.
- `feature_usage` — a counter for free-use quotas, not the financial usage ledger.

The CMS collections for plans, subscriptions and invoices are not retired in this repository. The contract they must follow is the ingest route and `cms_entitlement_projections` (a newer version never overwrites an older one).
