# Credit lease metering — Phase 0 spec (issue #998)

Hybrid and Full Offline installs keep consuming wallet credit without Internet, and the
cloud stays the only authority for balance, pricing and debit. This file records the
**Phase 0 decisions** (owner answers of 2026-10-18 plus the proposal agreed on 2026-10-25) and
what is already built. The full design (leases, local usage ledger, settlement, integrity)
is in issue #998 and is not repeated here.

**Status:** Phase 0 only. Nothing in the running product reads these tables or modules yet.
There is no lease issuer, no local ledger and no settlement endpoint.

## Meter classes

| Class | Runs | Example | Debit |
|---|---|---|---|
| A. Cloud-executed | cloud | AI chat, SMS/email, website/CMS, media | Synchronous cloud debit, unchanged. An offline site cannot use it anyway. |
| B. Site-executed per use | desktop | the three meters below | Lease, then settlement in the cloud |
| C. Time or volume | cloud | plan fee, add-on, daily storage | Cloud computes it from entitlement and period |

Only class B needs the new machinery. Everything priced today (`ai`, `messaging`,
`website_service`, the `media_*` keys) is class A.

## Class B meters (v1)

The list is data: `credit_offline_meters` (migration 0257). The superadmin can add a row or
change a mode without a deploy. `src/lib/billing/credit-lease/offline-meters.ts` holds the
seeds and an integration test pins the migration to them.

| Meter key | What is charged | Unit | Installs |
|---|---|---|---|
| `pos.sale_closed` | An order or retail invoice reaching its final settled state | 1 per closed order | Hybrid, Full Offline |
| `ledger.payroll_run_posted` | A payroll run posted to the books | 1 per run | Full Offline |
| `stock.count_posted` | A physical stock count posted | 1 per posted count | Full Offline |

All three are seeded in `shadow` mode (`off` / `shadow` / `enforced`): measured and rated,
never enforced. No price is set: unit prices live in `billing_price_versions` and are set by
the owner after the two-week shadow comparison.

Never metered: receipts and printing, shift open and close, exports, backups, reports,
label printing, login. Tax-invoice submission needs the Internet, so it is class A.

`billing_meters` and `METER_CATALOGUE` are audited against route segments and capability
declarations (`catalog/audit.ts`). These meters are deliberately **not** added there yet.
When settlement lands (Phase 1) each class B meter must also be registered in
`billing_meters` so `billing_usage_events` can reference it; that is a decision for that
change, not this one.

## States

```
lease  ->  over_lease_debt  ->  locked
```

- **lease**: units remain and the lease has not expired.
- **over_lease_debt**: exhausted or expired. Usage continues and is recorded as debt.
- **locked**: debt reached the ceiling. The plan's lock policy applies until the device
  reconnects and the debt is settled from the wallet or a top-up. A ceiling of zero means the
  lease running out locks at once.

The unit that crosses the ceiling is accepted (a sale is never half-closed); the lock applies
to the next one. Over-lease cost is `units x unit price x over_lease_price_bps / 10000`,
rounded up to a whole Rial, computed in BigInt. Top-ups pay debt first.

Lock policy: `block` refuses new metered work; `read_only` also refuses every other write.
**Always allowed, in every state:** closing open orders and shifts, receipts and printing,
export, backup, login, and reads.

Code: `src/lib/billing/credit-lease/policy.ts` (pure, integer Rial, unit-tested).

## Settings

Per plan, with a global default (`credit_lease_defaults`, `credit_lease_plan_overrides`; a
plan field left NULL falls through):

| Setting | Default | Notes |
|---|---|---|
| `offline_window_days` | 7 | 1 to 30. Leases are sized for this many days of expected use. |
| `debt_ceiling_rial` | 10,000,000 (1,000,000 Toman) per device | A placeholder: no prices exist yet to size it against. Revisit after the shadow period. |
| `over_lease_price_bps` | 10,000 (1.0x) | Basis points of the normal unit price. |
| `lock_policy` | `read_only` | `block` or `read_only`. The default is a code choice, not an owner decision; change it if `block` is wanted. |

Risk of the ceiling: the maximum uncollected exposure is the ceiling times the number of
devices that never reconnect. A ceiling set too low locks a shop in the middle of a trading
day because their Internet failed, which hurts the business more than the debt hurts the
platform, so err high.

## Notifications

Driven only by the lease expiry, the last successful sync, the last update check and the last
successful backup, never by whether a sync is currently running, so a stuck sync cannot hide
them. Code: `src/lib/billing/credit-lease/notifications.ts`.

| Level | Trigger | Dismissible | Modal |
|---|---|---|---|
| `notice` | 72 h before expiry (day 4 of 7), or no successful sync for 4 days | until next sign-in | no |
| `warning` | 24 h before expiry | no | no |
| `final` | 1 h before expiry | no | yes |
| `debt` | lease exhausted or expired, under 80% of the ceiling | no | no |
| `near_lock` | debt at 80% of the ceiling or more | no | yes |
| `locked` | debt at the ceiling | no | yes |

Each message names which of four jobs is overdue: sync (4 days), lease (within 3 days of
expiry), update check (7 days), backup (4 days). A job that has never succeeded counts as
overdue. Lease quota warnings at 50, 20 and 5% of units left are `quotaThreshold()`.

Copy is Persian and English, with the brand from `brandName(locale)`. Money and the expiry
date arrive pre-formatted (`formatMoney` in the business's unit, `formatJalali`), so the
module never spells a currency or a date.

## Coordination

- **#1041** owns the cloud hourly enabled-time meter and setup-once debit. #998 owns on-device
  metering, leases and settlement. Wallet authority is not duplicated.
- **Migration numbers:** this change uses `0257`. `0255` was taken by `import_reconciliation`
  (which is what blocks PR #1129) and `0256` by the open WP queue retention PR #1145. Whichever
  of the open PRs merges second renumbers.

## Still to do (later phases)

Lease document and signing, `wallet_holds`, `credit_leases`, `device_usage_events`,
the `offline_usage` and `offline_debt` ledger kinds, the settlement endpoint, the site
`usage_ledger` and `checkAllowance`, the banner and badge UI, the superadmin per-device view,
the hash chain and clock high-water mark, and the rollout (two weeks of shadow, then enforce).
