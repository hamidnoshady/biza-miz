# Commercial resolver: pricing, entitlement and usage

Status: **implementation contract for [#1378](https://github.com/hamidnoshady/biza-miz/issues/1378)**
(ESH-193). #1379 owns the Superadmin billing UI, #1380 the tenant billing and
commercial-availability UI, #1381 the release gate, #1382 coupon policy and
#1384 global identity. This document defines the server contract those UIs and
jobs consume; it does not replace any of them.

The wallet, plans, subscriptions, service activation, metering, invoice and
ledger foundations are unchanged. The resolver decides **what a charge is and
why**; it never invents a price and never posts money by itself.

## 1. Benefit identities

A benefit is the unit of commercial identity. It is a stable string from
`src/lib/billing/resolver/identities.ts`, never a display label, route name or
feature name:

| Shape | Example |
| --- | --- |
| Service benefit | `service:app:accounting/setup_once@services.activation` |
| Meter benefit | `meter:ai.credit/metered_usage@ai.chat` |
| Capability benefit | `capability:accounting.orders/access` |

The six kinds are deliberately separate because they are charged by different
rules:

| Kind | Meaning | Charged |
| --- | --- | --- |
| `access` | the right to use a capability | never by itself |
| `setup_once` | one-time provisioning per stable service | once per identity |
| `enabled_time` | rental while a service is deliberately enabled | per second / period |
| `metered_usage` | actual consumption | per unit, after allowance |
| `allowance_overage` | the part of usage beyond an included quota | per unit |
| `provider_cost` | a managed provider's cost | passed through or absorbed |

A price row, a plan inclusion, a usage event and an invoice line all point at
the same `benefitId`. A row whose `benefit_id` does not round-trip through
`parseBenefitId` is rejected, so a typo cannot create a phantom inclusion.

## 2. Deterministic precedence

`COMMERCIAL_MODEL_PRECEDENCE` is the fixed order, identical for
Subscription-only, modular PAYG and Hybrid:

1. **Prepaid service coverage** — while a purchased, published prepaid term
   covers an instant, enabled-time rental for that service is zero. The same
   second is never rented twice. Buying a term (`mode: "prepaid_term"`) is not
   coverage; it is the thing that creates it.
2. **Approved plan inclusion or discount** — applied to the published tariff
   (or to the part of a metered quantity beyond its allowance). A row is inert
   until `approved`; a row written for a *newer* policy version is invisible to
   a legacy tenant.
3. **Usage and allowance** — included quantity first, then overage. Overage
   disabled or a hard limit crossed is a refusal, never a silent zero.
4. **Overlap rejection** — the same benefit identity twice in the same period
   is `ambiguous_overlap`; a `metered_usage` and an `allowance_overage` line on
   the same meter is `incompatible_overlap`. Neither is summed.
5. **Price availability** — a published zero price is `free`; a missing or
   unpublished price is `no_published_price`. Absence is never free.
6. **No implicit activation** — every line carries `activatesService: false`.
   Inclusion grants access; activation is a separate authorized action.

`charges_tariff_when_included` is the only way an included service is still
charged its tariff, and it is an explicit, audited column — not a default.

## 3. Money and periods

- Integer Rial everywhere; Toman is display only (`formatMoneyText`/`useMoney`).
- Terms are 1, 3 and 12 **calendar** months with month-end clamping
  (`addCalendarMonths`: 31 Jan + 1 month is the last day of February).
- The billing calendar is `Asia/Tehran` for every period key, allowance reset
  and proration day count. `billing/resolver/calendar.ts` is the only copy; the
  AI allowance, plan quotes and subscription dates re-export it.
- A prepaid term's monthly allowances keep resetting each calendar month. A
  12-month term produces 13 calendar-month windows when it starts mid-month
  (partial, eleven full, partial) — the total coverage is exactly 12 months and
  no annual allowance is granted up front.
- Setup is charged once per stable identity; a re-enable never charges it again.
- Actual usage stays metered during a prepaid term; provider cost is separate.

## 4. Policy versions and legacy terms

- Policy version `0` is implicit and means **legacy**: only benefit rows with
  `policy_version = 0` can apply.
- A reviewed policy is a row in `billing_policy_versions` with `status =
  'active'`. A tenant applies it only through `business_commercial_policies`,
  written by `enrollCommercialPolicy` with the #1384 actor id and an audited
  note. No row means grandfathering: pricing, activation and suspensibility do
  not change.
- A new price is a new immutable version (`billing_price_versions`,
  `service_price_schedules`, `service_term_offers`). Historical intervals keep
  the version they settled at; nothing reprices a prior period.
- A stored quote/charge is compared with fresh facts at the final
  debit/posting boundary (`chargeStaleness`): `expired`,
  `price_version_changed`, `policy_version_changed`, `amount_changed` or
  `benefit_set_changed` refuses the charge and asks for a re-quote.

## 5. Service and usage pricing

| Case | Contract |
| --- | --- |
| Published setup | `setup_fee_rial` from the published `service_price_schedules` version |
| Included setup | `plan_included`, net 0; setup evidence written with `setupWaivedReason` |
| Free setup | explicit published 0 → `published_free`; never an absent tariff |
| Unpublished tariff | `not_configured` (activation) / `no_published_price` (resolver) |
| Enabled time | seconds × the interval's published hourly version, rounded up once per segment |
| Prepaid term | published `service_term_offers` row only; 1/3/12 calendar months |
| Inside a prepaid term | enabled-time amount 0, covered seconds recorded in charge metadata and usage dimensions |
| Metered usage | `rateQuantity`-equivalent arithmetic: allowance first, overage at the meter's published version |
| Provider cost | `pass_through` charges the published customer tariff (or the cost when nothing is published); `absorbed` is net 0 and internal |
| Setup/term debit | one wallet ledger row (`service_setup` / `service_term`) inside the same transaction that writes evidence |

A service is activated only by an explicit, authorized `activateService` after
a valid quote. Navigation, signup selection, plan inclusion or wallet funding
never activates or charges.

## 6. Lifecycle

`src/lib/billing/resolver/lifecycle.ts` and `proration.ts` encode:

- Auto-renew is explicit opt-in; off means the term simply ends.
- A renewal repeats the stored term. A failed renewal never silently becomes a
  shorter or longer term. The five-minute service tick runs the due renewals:
  it re-reads the published offer, locks the wallet and buys exactly the same
  term, or skips (no debit) when the wallet cannot cover it. The unique
  `(activation_id, period_start)` index makes a restarted tick a no-op.
- Insufficient wallet uses the existing grace/`past_due` window, then lapses.
  No debt is created.
- Cancellation preserves access until the paid period ends.
- Proration is configuration (`none` default or `daily`). `daily` credits only
  the unserved days and charges the target for the same days; both periods use
  one denominator, so nothing overlaps and the elapsed past is never repriced.
  The quote is available read-only (`plan_transition`); the *charging* path for
  a cross-plan purchase is still the existing boundary behaviour and remains a
  release-gated decision (see §11).
- Setup is not repeated on reactivation; a lapsed period is closed, not
  re-billed.

## 7. Commercial availability vs access (#1380's contract)

`resolveCommercialAvailability` returns separate fields — never one boolean:

`industryEligible`, `deploymentEligible`, `platformAvailable`,
`roleEligible`, `effectiveAccess`, `legacyAccess`, `planEntitlement`,
`activationState`, `activationRequired`, `suspended`, `retentionReadable`,
`purchasable`, `restricted`, `restrictionReason`, `safePreviewAllowed`,
`setup` (itemised), `hourlyRial`, `termOffers`.

`enforceCommercialServiceAccess` is the server-boundary check:

- industry, deployment, platform availability and permission refusals come from
  the existing registries and the existing effective-access resolver;
- `restricted` is possible only for an **enrolled** tenant with a paid service
  that is pending/suspended; a legacy tenant is never restricted;
- a denial returns the projection plus the exact wallet shortfall, and a fresh
  quote is required after funding;
- safe preview data stays readable, and `retentionReadable` mirrors
  `SERVICE_STATE_META` so read/export rights survive suspension.

The «فعال‌سازی» sidebar label is commercial, not an authorization gate.

## 8. Stable API contract

Tenant service route `GET /api/services/{kind}/{key}` (unchanged path) now also
returns `commercial` (the projection above). No existing field changed.

`POST /api/services/{kind}/{key}` accepts, besides
`activate|disable|reenable|settle`:

| Action | Body | Result |
| --- | --- | --- |
| `term_quote` | `{ termMonths: 1\|3\|12 }` | `{ quote }` — itemised, with offer period, allowance periods, wallet requirement and shortfall |
| `term_purchase` | `{ termMonths, offerId, expectedNetRial, autoRenew? }` | `{ purchase }` or `409 term_stale|term_overlap|no_activation` or `402 insufficient_credit` |

The existing tenant quote route accepts one additional read-only kind:

| Kind | Body | Result |
| --- | --- | --- |
| `plan_transition` | `{ kind: "plan_transition", planKey }` | `{ ok, quote, current, target, prorationPolicy, taxRateBps }` — an upgrade/downgrade quote under the configured policy. `current.creditBasis` says whether the credit is derived from a paid invoice or a labelled published-price estimate. It moves no money and changes no subscription; charging a transition remains a release-gated decision. |

`activate`, `reenable` and `term_purchase` are gated by
`enforceCommercialServiceAccess`; `disable` is never blocked, and `settle`
charges only through the tariff-aware settlement path.

Every quote response carries, per line: benefit id, kind, quantity and unit,
gross, allowance, inclusion, discount, net, price state, price version, policy
version, effective period and an explanation code. Money is integer Rial.

Invoices are built from the persisted quote (existing
`purchase-invoice-service.ts`), so a settled invoice reconciles to the quote's
gross, both discount components and tax without re-deriving a price.

## 9. Identity boundary (#1384)

- Billing references the global person (`platform_users.id`) and the payer
  business; it stores no phone, email, OTP, password or national ID.
- The acting business comes from the authenticated membership/session, never
  from a phone number, request body or slug.
- Billing may read the narrow verification signal through #1384's helper; it
  never writes identity or verification rows, and adds no second phone rule.
- Commercial audit rows use the #1384 actor id.
- The two issues own separate migrations and never provision each other's data.

## 10. Migration and rollout

- `0309_commercial_resolver.sql` is additive: three to five new tables and one
  widened `wallet_ledger.kind` check. No existing row, price or term changes.
- Forward: run migrations, then nothing else — legacy tenants keep pricing.
  Enrolment is an explicit per-tenant write.
- Rollback: drop `business_service_terms`, `business_commercial_policies`,
  `service_term_offers`, `billing_plan_benefits`, `billing_policy_versions` and
  restore the previous `wallet_ledger_kind_check`. No historical financial row
  is rewritten.
- A production migration rehearsal must use synthetic/sanitized data and is
  coordinated with #1381.

## 11. Verification status (kept separate on purpose)

| Gate | Status |
| --- | --- |
| Code complete | this change: resolver, service/usage pricing, terms, lifecycle, projection, tests |
| Migration ready | `0309` written; production rehearsal **not run** |
| Financial policy approved | **not yet** — discount rates, coupon stacking and provider pass-through remain configuration |
| Deployed | **no** |
| Tenant rollout | **not started** — no tenant is enrolled by this change |

Do not mark the resolver complete from quote-calculator unit tests alone: the
database suite (`integration/commercial-resolver.integration.test.ts`) and the
existing billing suites are part of acceptance.

## 12. Verification run (this change)

Commands and outcomes, on a Windows development worktree with Postgres 16:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run src/lib/billing/resolver src/lib/service-activation src/lib/mcp/server.test.ts src/lib/ai-plan-allowance.test.ts src/lib/billing/quote` | 142 passed |
| resolver pure suite after the final coverage additions | 45 passed |
| `DATABASE_URL=… npx vitest run --config vitest.db.config.ts integration/commercial-resolver.integration.test.ts` | 23 passed, including 12-month terms, term-expiry back to rental, empty-wallet renewal skip, policy-change staleness and the read-only transition quote |
| 11 billing DB suites (resolver, service activation, subscriptions, wallet, commercial, quote store, plan checkout, plan quote ×2, purchase fulfilment, tenant isolation) | 133 passed |
| resolver + tenant-isolation suites | 40 passed, including the RLS census |
| `npm run test:design` | 47 passed |
| `npx eslint` on every changed file | clean |
| `npm test` (whole repository) | 15,790 passed; failures limited to environment-only gates — WSL `bash` is a broken launcher for `ci/required-gate` (7), desktop installer/update tests need packaged artifacts (9), and three jsdom/compiler tests exceeded the 15s load threshold (both re-run green with a longer timeout: `client-bundle-boundary` 30s, `cheques-section` 72s) |
| Migration rehearsal on a synthetic database | 528 migrations applied; 0309 applied, reversed, re-applied, and re-applied again (idempotent). Legacy rows unchanged (`1` business, `2` ledger rows, `2` rows summing 5,300,000 Rial). Both tenant tables report `rowsecurity`; `service_term` is accepted by the wallet check and an unknown kind is rejected. No production data was used. |

The build (`npm run build`) result is recorded in the issue report; it is a
deployment gate, not part of this document's contract.

