# Effective access — who decides whether a business may use a capability

One question, answered in one order, by one rule set (`src/lib/effective-access.ts`).

| # | Layer | Question it answers | Where it lives |
|---|---|---|---|
| 1 | App availability | Is the app released and working right now? | `app-availability.ts`, `withTenantScope` → `app_unavailable` (503) |
| 2 | Industry module | Does this trade have the capability at all? | `industry-profile.ts` → `module_unavailable` |
| 3 | Rollout flag | Is the capability switched on for this business? Audited billing override > legacy business override > catalogue default. | `resolveFlagLayer`, read by `effectiveFeatureDetails` (`features.ts`) |
| 4 | Commercial | For a capability **the plan prices**: is it included, an owned add-on, a promo or a manual grant — and does the subscription still carry the plan? | `resolveCommercialLayer`, fed by `resolveFeaturesAccess` |
| 5 | Limits, permission, wallet | Counts, the acting user, cover for a metered use. | `resolveBusinessLimit`, the route's own guard, `chargeForFeature` |

Layers 3 and 4 used to be answered by two code paths that each knew half of it.
The request gate (`isFeatureEnabled`) read only the legacy business override; the
structured resolver (`resolveBusinessCapability`) also read the audited billing
override, the plan row and the subscription. Both now call the same two pure
functions, so a capability override created in the billing console is enforced
at the gate, and a priced add-on nobody bought is refused by both.

## What is and is not enforced

- **A capability the plan does not price is governed by the flag layer alone.**
  Billing is opt-in per capability. This is why a tenant can hold `ai_assistant`,
  `integrations` or `api_platform` through an override with no plan row and no
  entitlement: that is the designed shape of an operator exception, and the
  access report calls it `gate_on_without_plan_row`.
- **A capability the plan prices is enforced at the gate** (add-on ownership,
  plan inclusion, subscription lapse). Pay-as-you-go survives a lapse.
- **The six look-alike pairs** (`feature-catalogue.ts`) are a gate key and a
  commercial key for the same area. The gate refuses on the left key; the plan
  prices the right key. The plan's inclusion of the right key does **not**
  switch the left key on or off — whether it should is a product decision, not
  a code default. The per-business access report
  (`GET /api/platform/billing/businesses/[id]/access`) shows both sides and
  classifies the pair.

## Adding a capability

1. Add the flag to `feature_flags` (a key a path prefix in `features.ts` or a call site gates on).
2. If a plan should price it, add the plan row under **the same key**. A plan row under a different key never influences the gate; if the two keys must differ, add the pair to `FEATURE_RELATIONS` with a Persian explanation.
3. Never read `business_features` or `business_billing_overrides` directly to decide access — call `isFeatureEnabled` / `effectiveFeatureDetails` / `resolveBusinessCapability`.

## Purchases

A verified plan or add-on payment is applied once and invoiced once:
`billing_payments.plan_activated_at` is stamped in the subscription's own
transaction (`changeBusinessPlan({ paymentId })`), fulfilment is a per-payment
critical section, and `issuePurchaseInvoice` creates the `plan-purchase:<id>` /
`addon-purchase:<id>` invoice settled by that payment. History is repaired with
`scripts/backfill-purchase-invoices.ts` (dry run by default; see the script's
header before running it with `--apply`).
