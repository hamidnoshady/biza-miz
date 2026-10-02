# Platform Business — کسب‌وکار پلتفرم

## Architecture

The platform company is one ordinary RLS-protected business with
`businesses.ownership_kind = 'platform_internal'`. A partial unique index makes that marker a
singleton; the mutable name and subdomain are never used as identity. Its trade profile is
`service_saas`, while ownership remains an independent lifecycle field.

There are still exactly four app keys (`accounting`, `crm`, `growth`, `website`). My Workspace
continues to extend `ai_projects`; it is an entitlement/work area, not a fifth app.

`POST /api/platform/company/setup` is the explicit, idempotent central-cloud initializer. It
creates the chart only on the first provision, grants the four app entitlements plus Workspace,
and maps the initializing platform identity to a real tenant membership. It never reruns opening
balances. Ordinary customer list/count, subscription renewal, reset, archive and delete paths
exclude or refuse the protected business. Whole-system backup continues to include it.

## Authorization and switching

`withPlatformCompany()` is the central adapter. It rechecks the active platform identity and
active company-member mapping, applies the business preset, and then replaces the platform RLS
bypass with the internal business tenant scope and mapped `users.id`. No company endpoint accepts
a business id.

Opening an app creates a two-minute, one-use staff handoff. Redemption rechecks the admin,
company mapping, business and tenant membership, then creates a normal host-scoped tenant session
for that real membership. It is not customer impersonation and creates no impersonation grant.
Revocation (`is_active`) and preset changes take effect on the next company API call or handoff.

Presets: company owner, finance, sales/customer success, marketing, website editor and project
manager. The company home includes owner-only assignment/revocation controls. Presets are persisted
as exact tenant permission overrides, so existing tenant sessions observe changes immediately;
revocation also deactivates the mapped tenant user. Infrastructure role capabilities are not
consulted for business operations.

## Billing posting rules

Billing Control Center remains authoritative. Database triggers transactionally append only new
source transitions to `platform_company_billing_events`; migration, setup and startup never
backfill old sources (see *Historical data* below).

### Accounts

| Code | Name | Role |
|---|---|---|
| 1110 | Bank | Money actually received |
| 1200 | Accounts receivable | Customer invoices |
| 2100 | Accounts payable | Provider invoices |
| 2455 | Customer wallet liability | Wallet balances held on behalf of customers |
| 4400 | Sales returns and allowances | Cash/wallet refunds |
| 4500 | Subscription and usage income | Earned revenue and its reversals |
| 5670 | Hosting/storage/messaging cost | Authoritative provider cost |

### The settlement model

The invoice is **not** the settlement record. Two sources are, and they are the only ones the
invoice's own trigger will not double-count:

* a `wallet_ledger` **debit** carrying `metadata.invoiceId`, and
* a `billing_payments` row that has transitioned to **`verified`**.

Each emits its own `invoice_payment` event, clipped to whatever was outstanding **before that
source row**. Both source triggers run AFTER the write, so the settled-total helper already
includes the new debit/verified payment; its amount is added back before clipping. The explicit
historical backfill uses the same calculation. The invoice trigger then emits only the **residual** — the part of `paid_rial` no
settlement record accounts for — tagged `settlement='residual'`/`method='other'`. So a
600,000-rial wallet debit plus 400,000 rial by other means on a 1,000,000-rial invoice produces
two postings with two different debit accounts, and no invented third one. The previous
implementation guessed the method with an unfiltered
`SELECT 1 FROM wallet_ledger WHERE metadata->>'invoiceId' = $1`, which was blind to refunds and
all-or-nothing for a mixed settlement.

### Posting table

| Billing fact | Debit | Credit |
|---|---|---|
| Invoice issued | A/R 1200 | Subscription/usage income 4500 |
| Invoice settled from the customer wallet | Wallet liability 2455 | A/R 1200 |
| Invoice paid by gateway / manual / residual | Bank 1110 | A/R 1200 |
| Invoice voided, nothing paid | Subscription/usage income 4500 | A/R 1200 |
| Invoice voided, partly paid | Income 4500 (full) | A/R 1200 (outstanding) + Wallet liability 2455 (collected) |
| Credit note (negative `billing_adjustments`) | Income 4500 | A/R 1200 |
| Commercial adjustment, positive, with a reason | A/R 1200 | Income 4500 |
| Wallet top-up | Bank 1110 | Wallet liability 2455 |
| Wallet spend with no invoice | Wallet liability 2455 | Subscription/usage income 4500 |
| Wallet refund | Sales returns 4400 | Wallet liability 2455 |
| Cash refund | Sales returns 4400 | Bank 1110 |
| Promotional / noncash credit | No posting; retained as an **ignored** reconciliation event |
| Authoritative provider cost | Provider cost 5670 | A/P 2100 |

A void of a partly-paid invoice never deletes the money that arrived: revenue is reversed in
full, the unpaid balance goes back to A/R, and the amount actually collected becomes a customer
credit until a refund settles it. The old rule (`Sales returns 4400 / A/R 1200`) credited the
receivable for the whole invoice, which silently erased a real collection.

### Idempotency, ordering and failure

Unique source versions (`source_table, source_id, source_version`) and unique posting references
make delivery and posting idempotent at the database level, so neither a duplicated trigger nor
two workers claiming at once can post the same fact twice. Events are claimed with
`FOR UPDATE SKIP LOCKED`, ordered by occurrence (so an out-of-order settlement still posts),
retried with backoff, and stale processing leases recover automatically.

A customer mapping and every account mapping must exist before a customer event posts; missing
mappings stay visible as failed events with a `failure_kind` of `missing_account`,
`missing_customer`, `transient` or `permanent`. The Accounting page exposes every state and an
authorized retry — but a `permanent` failure shows *why* it cannot succeed instead of a retry
button that will not help.

### Customer mapping

The bridge creates a legal-party/customer mapping from the platform directory name on the first
authoritative billing event, under a per-customer transaction lock. It never reads the customer
tenant's CRM, contacts, documents or ledger. Two tenants that share a business name get their own
party each: `platform_company_customers` is unique on `(business_id, party_id)`, so a party is
adopted only when it is genuinely orphaned (same name, referenced by no customer row) — the
recovery path for a run that died between the two inserts. A tenant therefore maps to exactly one
company customer, and one company customer may own several tenants.

CRM's read-only balance endpoint derives balances **only** from the receivable (1200) journal
lines linked to Accounting postings (`balanceSource: "accounting_postings"`), never from an
invoice's operational `paid_rial`/status or the whole amount of a void event. This includes the
outstanding portion of a posted void, credit notes and positive commercial adjustments, while
excluding wallet liabilities, cash and provider costs. The compatibility fields `invoicedRial`
and `settledRial` carry posted A/R debit and credit totals; the UI labels them بدهکار / بستانکار
rather than calling a cancellation or credit note a cash collection.

MRR and similar Billing metrics are operational metrics. They are not labelled as posted revenue.
A won deal or completed project never posts revenue.

## Money, dates and units

Money is stored as integer **Rial** everywhere and rendered through `useMoney()` / `formatMoney`
in the business's chosen unit (`settings('business.prefs')->currencyDisplay`, default Toman). No
company screen divides by 10 by hand. CRM/Workspace money-consuming content must mount as a
**descendant** of `CompanyWorkspace`'s `MoneyProvider`; a hook in the page returning that shell
would read the outer/default unit instead. Every user-visible date is Shamsi (Jalali) via
`formatJalali`. A static test in `src/app/api/platform/company/route-guards.test.ts` fails the
build if a company file reintroduces a hand-rolled unit conversion, a hard-coded unit label or a
`toLocaleDateString`.

## Growth summary

Consent coverage reuses the shared CRM `consentCoverage()` engine: current `parties.sms_consent`
and `marketing_consent` flags on active, unmerged customer parties. Historical grants in
`crm_consent_events` remain an audit trail, not a current audience. `partiesWithConsent` counts
the union of the two channels once per party, not the maximum or sum of channel totals.

Upcoming renewal candidates are explicitly mapped customer tenants with an active business,
a renewable subscription status (`active`, `trialing`, `past_due`), no scheduled cancellation,
and a period end between now and 14 days from now (inclusive). Past periods, cancelled/expired
subscriptions, archived businesses and unrelated/unmapped tenants are excluded. The summary
never activates a campaign or sends a reminder.

### Review regressions

`integration/platform-company-review.integration.test.ts` drives source triggers, posting and the
real CRM/Growth handlers with a signed platform session and a `NOSUPERUSER/NOBYPASSRLS` runtime
role. It covers full gateway/manual payment, payments larger than half the invoice, real mixed
600k wallet/400k verified gateway settlement, duplicate verification, posted voids (unpaid,
partially paid and fully paid), adjustments/credit notes, consent revocation/overlap, the renewal
window and the actual backfill CLI's dry-run/application/replay behavior. Fixture setup alone
uses the database owner; no application guard or tenant scope is mocked.

`src/app/platform/company/company-money.test.tsx` mounts the actual company shell/provider and
both money-consuming pages in Rial and Toman, under an opposite outer money context. It covers
balances, wallet/open-invoice amounts, deal values, project budgets, forecasts and posted actuals.
These regressions reproduce the reviewed defects before the fixes rather than only checking
source-code shapes.

## Operational scripts

```bash
# Read-only health check: entitlement, membership, mapping, posting and failure counts.
npm run platform-company:health

# Deterministic, non-destructive repairs only (missing entitlements, app availability,
# a subscription row left auto-renewing). Nothing is deleted.
npm run platform-company:health -- --apply --actor=<platform-admin-uuid>
```

Both run against the central install. The billing tick and the maintenance tick are scheduled
only on a central deployment (`DEPLOYMENT_ROLE=central`).

### Tested on both paths

0193 is covered two ways, because "it applies" and "it applies to a live system" are different
claims:

* `integration/platform-company.integration.test.ts` builds a database from scratch.
* `integration/platform-company-migration.integration.test.ts` builds one at 0192, seeds it the
  way a running system leaves it (a company, a mapped customer, a posted event with its journal
  entry), and applies 0193 on top — then checks that the leaky policy is gone, every pre-existing
  row survived, no write path is open to a tenant, and the idempotency keys landed.

If someone edits 0191 in place, the second suite is what fails.

## Website lead intake

Website editors create or rotate a show-once credential from the Websites page. Each credential is
bound to one `site_key` and either `eshobe` or `wordpress`; it has no tenant read permission.
Forms submit a bounded JSON body to `POST /api/website/leads` with `Authorization: Bearer …` and an
`Idempotency-Key` header. The endpoint validates contact data, normalizes Iranian phone numbers,
uses a honeypot, applies a durable per-credential minute limit, records attribution and the consent
snapshot, and creates one CRM lead. Retries return the original identifiers without duplicate CRM
records. Marketing consent is recorded but does not itself activate or send a campaign.

## Historical data and rollback

The backfill is **explicit only**. It is never run by a migration, at startup, or as part of a
deployment, and the default is a dry run that writes nothing:

```bash
# Dry run: candidate counts per source, per window. Writes nothing.
npm run platform-company:billing-backfill -- --cutoff=2026-09-30T23:59:59Z

# Optional lower bound.
npm run platform-company:billing-backfill -- --from=2026-01-01T00:00:00Z --cutoff=2026-09-30T23:59:59Z --apply

# Explicit enqueue (never run as part of deployment).
npm run platform-company:billing-backfill -- --cutoff=2026-09-30T23:59:59Z --apply
```

It reproduces the **same event model live operation produces** — the same `(source_table,
source_id, source_version)` tuples and the same clipping helper
(`platform_company_invoice_settled_rial`) — so replaying a window that live operation already
covered adds nothing at all, and a window it missed is reconstructed identically. A static test
asserts that parity. Without it, a second accounting model would quietly produce a different
ledger from the same facts.

To disable rollout, deactivate company memberships or entitlements and stop the worker. Keep
pending/failed events for recovery. Do not delete posted journal entries; use normal reversing
accounting documents.

## Canonical routes

Browser pages (Central only, platform session required):

| Route | Purpose |
|---|---|
| `/platform/company` | Company home: state, entitlements, members, the four app destinations |
| `/platform/company/workspace` | My Workspace — projects, plan figures vs posted actuals |
| `/platform/company/accounting` | Billing → Accounting reconciliation, per-event state and retry |
| `/platform/company/crm` | Customers and won deals; «ایجاد پروژه» hands a deal to My Workspace |
| `/platform/company/growth` | Growth audience summary; renewal candidates in Shamsi dates |
| `/platform/company/websites` | Site credential manager (show once) and the app handoff |

APIs under `/api/platform/company/**` (every handler runs `withPlatformScope`, except `/status`
and `/setup`, which exist precisely to establish what that adapter requires — the exception is
allow-listed by name in `route-guards.test.ts`):

| Route | Methods |
|---|---|
| `status` | GET |
| `setup` | POST |
| `members` | GET, PATCH |
| `open` | POST (mints the one-use handoff) |
| `accounting/reconciliation` | GET, POST (POST = authorized retry) |
| `crm/customers`, `crm/deals` | GET |
| `growth/audience` | GET |
| `workspace/projects` | GET |
| `workspace/from-deal` | POST |
| `websites/sites`, `websites/credentials` | GET, POST |

Plus two non-company routes that serve the same feature: `GET /api/auth/company-handoff`
(redeems the token on the tenant origin) and `POST /api/website/leads` (public, bearer-token
intake that resolves the credential under the platform bypass and then writes under the internal
company's tenant scope).

The app pages hand off to the existing shared engines — Accounting, CRM, Growth, Websites and My
Workspace — and never duplicate them. There are exactly four app keys; My Workspace is a work
area, not a fifth app. Platform Management (`/platform/businesses`, `/platform/billing`, …)
remains a separate realm and is not the company console.

## Defects fixed in this implementation

### From the original PR #790

- `src/lib/platform-service.ts`: customer directory and acquisition counts included every business;
  the protected internal company is now excluded.
- `src/lib/subscription-service.ts`: generic renewal could suspend any business with a subscription
  row; ownership is now checked both in direct renewal and the scheduler query.
- `src/app/api/platform/businesses/[id]/route.ts`: reset/delete/lifecycle endpoints had no protected
  ownership policy; internal-company mutations now fail with `protected_internal_business`.
- `src/app/api/platform/billing/overview/route.ts`: customer commercial KPIs had no ownership filter;
  internal activity is no longer counted as customer revenue, wallets or acquisition.
- Workspace project creation had no durable external idempotency key. `creation_key` now prevents a
  retried CRM deal handoff from creating duplicate projects.

### Found and fixed during the post-deploy audit

- **Billing outbox RLS leak.** The read policy was keyed on `customer_tenant_id = app_current_business()`,
  which let every customer tenant named in an event read AND write those rows. Migration 0193
  drops it and replaces it with a policy keyed on `internal_business_id`, plus write policies that
  require `app_rls_bypass()` (the worker) — proven by integration tests running as an unprivileged
  `NOBYPASSRLS` role.
- **Settlement guessed, not accounted.** Replaced with the wallet/verified-payment/residual model
  above; a mixed 600k-wallet + 400k-other settlement now produces two different postings.
- **Void of a partly-paid invoice erased the collection.** It now reverses revenue in full, cancels
  the outstanding receivable, and credits the amount collected to the customer's wallet liability.
- **Duplicate customer party collision.** Two tenants sharing a business name collided on
  `platform_company_customers(business_id, party_id)` and failed every event forever. A party is
  now adopted only when orphaned.
- **CRM customer card fan-out.** A single `GROUP BY` across the tenant × events × postings joins
  repeated one tenant once per billing event and multiplied every balance by the same factor.
  Each roll-up is now its own scalar sub-query.
- **Provisioning read `businesses.prefs`,** a column that does not exist, on every status call.
  The money unit is read from `settings('business.prefs')->currencyDisplay`, like everywhere else.
- **Project revenue aggregation read `journal_lines.project_id`,** which does not exist; it now
  groups on `journal_entries.project_id`.
- **The link-validation trigger referenced a `campaigns` table that does not exist** (the Growth
  engine's table is `message_campaigns`).
- **The destructive business operations were guarded only at the HTTP route.**
  `resetBusiness()` and `hardDeleteBusiness()` had no internal-company check, so
  any non-HTTP caller — a maintenance script, a future job — could have wiped
  the platform's own books. Both now refuse inside the transaction that would
  have done the damage, with a dedicated `ProtectedInternalBusinessError`.
- **Adding any member after the founder failed outright.** Every
  `PATCH /api/platform/company/members` call except the very first returned
  `new row violates row-level security policy for table "platform_users"`. The
  founder worked only because `ensurePlatformCompany()` runs bypassed; every
  later member went through `withPlatformCompany()`, which is inside the
  company's tenant scope — and `platform_users` carries
  `WITH CHECK (app_rls_bypass())`, so the INSERT can never succeed from there.
  The identity INSERT/SELECT is now bracketed in
  `withoutTenantScope("platform", ...)`, the documented narrow-cross-realm-write
  shape, and throws `platform_identity_unavailable` if the row is still missing.
  No policy was widened.
- **The billing tick ran on every deployment role.** It and the maintenance tick are now central-only.
- `platform_billing` had no Persian ledger source label, so company entries showed raw English in
  the journal and reports drill-down.

No route or helper in this affected scope was verified as dead, so none was deleted merely from a
text search. Existing customer routes remain compatible.
