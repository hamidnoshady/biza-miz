# Campaign builder (issue #901)

The Growth app's no-code campaign builder: a campaign is a typed **trigger → reward** rule under a
**hard budget**, simulated against real sales before anything is launched. This page records what the
first slice ships, the decisions behind it, and what is deliberately not built yet. Issue #901 stays open
for the remaining waves.

## What ships in the first slice

| Piece | Where |
| --- | --- |
| Tables `growth_campaigns`, `growth_campaign_versions` (RLS, locked-version guard) | `migrations/0262_growth_campaign_builder.sql` |
| Rule document, validation, plain-language summary, dry-run simulation (pure) | `src/lib/campaign-builder.ts` |
| Storage, audit, and the read-only history replay | `src/lib/campaign-builder-service.ts` |
| Routes: list/create, read/save/archive, simulate | `/api/growth/campaign-builder[/id[/simulate]]` |
| Permissions (`campaigns.view` reads, `campaigns.manage` writes and the dry run) | `GROWTH_API_PERMISSIONS` in `src/lib/growth-access.ts` |

One trigger — `pos_sale_settled` (a completed POS sale, optionally limited to branches and a minimum
settled amount) — and one reward — `cashback` (percent in basis points, or a fixed amount, with a
per-order ceiling and a return hold in days). There is **no screen yet**: the API is the contract the
guided builder and the #1012 template gallery will sit on.

## Decisions

- **Not `promotions`, not `message_campaigns`.** Those stay the execution primitives for price rules and
  outbound messages. Nothing is migrated or duplicated.
- **Settled net paid, never the order total.** The basis is every payment row except the on-account
  («نسیه») tender, with refunds (negative payment rows) netted. A voided, unpaid or fully refunded sale
  earns nothing. `net_paid_excl_tax` removes the sale's tax in proportion to the paid share, rounded so
  the removed share is never understated.
- **Integer arithmetic.** A reward is `floor(base × bps / 10000)` in BigInt.
- **A campaign that cannot pay is invalid**, not live and silent: a fixed reward above its own budget or
  per-customer cap, a per-order ceiling below the fixed amount, an empty branch list. Unknown fields are
  rejected; the document is versioned by `schemaVersion`.
- **Budget blocks, customer cap clips.** A reward that does not fit the remaining budget is turned away
  whole (a half-reward is a number nobody promised); a customer's last reward is reduced to their cap.
  The budget is mandatory — the existing `discountBudgetRial` setting stays an advisory threshold.
- **Versions lock.** `locked_at` makes a version immutable in the database (rules, hash, number; no
  delete). Editing after the lock creates the next version. The slice only writes drafts, but no later
  code path can forget the lock.
- **The dry run writes nothing.** `simulateSavedCampaign` only reads `orders`/`payments`; its result
  carries `dryRun: true` and `ledgerEffect: "none"`, and the integration test asserts no journal entry or
  domain event is created. The response carries order ids and totals, never customer ids.

## Not built yet

- **Accounting.** No reward is reserved, no liability recognised, nothing posted. Marketing cashback is
  not a sales return, so `loyalty.store_credit_issued` (Dr 4400) must not be reused. The accounts and
  timing (on reservation, on release after the hold, on redemption) need an accountant-approved policy
  before the posting rule is written.
- Approval, launch, pause and the status transitions beyond `draft` → `archived` (the status column
  already carries the full vocabulary).
- The reward ledger (`pending → available → redeemed / expired / reversed`), idempotent issuance on the
  sale event, and redemption as a sale tender.
- Other triggers (CRM, schedule, Woo/CMS) and rewards (discount, points, message), the guided builder UI
  and the template gallery (#1012), campaign reports, fraud rules.
