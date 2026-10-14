# Phase 22 — Accounting Standards Compliance & Multi-Industry COA

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 7 (double-entry ledger), Phase 16 (accounting suite), Phase 21 (multi-industry
accounting platform)
**Tracks:** GitHub issue [#160](https://github.com/hamidnoshady/cafe-restaurant-pos/issues/160)
**Goal (of #160 as a whole):** bring the accounting layer — terminology, chart-of-accounts structure,
and industry coverage — up to a standard an accountant would recognize as correct, and make it
extensible to future industries without touching Core Accounting each time.

This document is Wave 1 of #160: **"Audit کامل وضعیت فعلی حسابداری و تهیه Gap Analysis"** (a
complete audit of the current accounting state and a gap analysis). It does not change any code —
it inventories what already exists, maps it against every scope item #160 lists, and turns what's
left into a concrete, sequenced backlog for Waves 2+.

---

## 0. Why this audit changes the shape of the remaining waves

#160 was written as if the accounting layer were being built from a blank slate: its own Wave-Based
plan (§8) proposes "Wave 2: fix Core Accounting Engine and the account data model", "Wave 3: redesign
a standard general chart of accounts", "Wave 5: jewelry template", etc.

That's not the starting state. **Three phases already shipped most of this:**

- **Phase 7** — double-entry ledger, a Persian F&B chart of accounts, auto-posting for order
  payment/COGS/purchases/waste, trial balance.
- **Phase 16** — fiscal years/periods with hard locks, P&L/Balance Sheet/Cash Flow with drill-down,
  year-end closing entries into retained earnings, AR and AP subledgers with aging, bank/cash
  reconciliation, a draft→review→post manual-journal workflow with reversal, chart-of-accounts
  customization (sub-accounts, rename, archive, protected delete), expense management, payroll
  accrual/payment, VAT reporting.
- **Phase 21** — the exact "multi-industry platform" #160 asks for in its §6 and §5: an immutable
  `businesses.industry` column, a domain-event log + posting-rule engine industry modules register
  against (instead of copy-pasting ledger code per industry), a generic Item/Variant/Serial model, and
  — critically — **Waves 1-4 of a full jewelry (طلا و جواهر) accounting module already shipped**:
  weight/purity tracking, daily gold pricing, the making-charge/profit/VAT formula, stone cost
  add-ons, and consignment (امانی) sale posting with its own subledger-style liability account —
  reachable today through `/api/jewelry/*` and `/dashboard/jewelry`.

So #160's real job is narrower than its own wave plan implies: **standards/terminology hardening on
top of an already-working double-entry system**, plus finishing the two industries Phase 21 hasn't
reached yet (watch, accessories — already Phase 21's own Waves 5-6). Duplicating Phase 21's jewelry
work under a new #160 "Wave 5" would be redoing shipped work; the gap analysis below is written to
avoid that.

---

## 1. Common Accounting Core (#160 §1) — mapped

| §1 item | Status | Where |
|---|---|---|
| Chart of Accounts | **Exists** | `src/lib/coa-template.ts` (`FNB_COA_TEMPLATE`, `JEWELRY_COA_TEMPLATE`), `accounts` table (migration 0001) |
| گروه/کل/معین/تفصیلی (group / general-ledger / subsidiary-ledger / detail-ledger hierarchy) | **Gap** | See §7.1 below — only generic `parent_id` nesting exists, no standard 4-tier level classification |
| ماهیت بدهکار/بستانکار (debit/credit nature) | **Partial gap** | Inferred implicitly from `account.type` in report code (e.g. `reports-service.ts:225`); never stored or surfaced as an explicit "nature" field. See §7.2 |
| حسابهای عادی و کاهنده (normal vs. contra/reducing accounts) | **Gap** | `salesReturns` (4400), `nrvAllowance` (1390) behave as contra accounts today but nothing marks them as such — no `is_contra` concept anywhere in `src/lib`. See §7.2 |
| حسابهای موقت و دائمی (temporary vs. permanent accounts) | **Implicit, not modeled** | Revenue/expense accounts are temporary in effect (zeroed by `closeFiscalYear`, `src/lib/closing-service.ts`) but this falls out of `account.type`, not an explicit flag |
| حسابهای کنترلی (control accounts) | **Exists, implicit** | `accountsReceivable`/`accountsPayable` behave as control accounts (AR/AP subledgers reconcile to them "to the Rial" by construction, Phase 16) but again, not a named/marked concept |
| حسابهای سیستمی و غیرقابل حذف (system / non-deletable accounts) | **Exists** | `WELL_KNOWN_CODES` (`coa-template.ts`) protected in `accounts-service.ts`'s `setAccountActive`/`deleteAccount` — a well-known code can never be archived or deleted. Not surfaced as a UI-visible "این حساب سیستمی است" badge distinct from the generic archive/delete-blocked state |
| بستن دوره مالی (period close) | **Exists** | Phase 16 fiscal years/periods, `enforce_fiscal_period_lock` trigger |
| افتتاحیه و اختتامیه (opening/closing entries) | **Exists** | Opening: Phase 1 wizard opening balances → `openingEquity`/`historicalInventoryReconciliationEquity`. Closing: `closeFiscalYear` → `retainedEarnings` |
| سود و زیان انباشته (retained earnings) | **Exists** | Well-known code 3800, migration 0025 |
| تراز آزمایشی (trial balance) | **Exists** | `GET /api/ledger/trial-balance`, "تراز آزمایشی" tab |
| دفتر کل و معین (general ledger & subsidiary ledger) | **Partial gap** | The "دفتر روزنامه" (journal) tab, `getAccountDrillDown`, and the report builder's `v_ledger_by_account` ("دفتر حساب‌ها") view (`src/lib/reports.ts:132-151`, debit/credit summed by account/day/week/month) together cover the underlying data, but none of them is a dedicated per-account statement with a running opening→closing balance — the standard دفتر معین presentation. See §7.3 |
| صورت سود و زیان (P&L) | **Exists** | Phase 16, with period comparison |
| ترازنامه (balance sheet) | **Exists** | Phase 16, with period comparison |
| گردش حسابها (account turnover/movement) | **Partial gap** | Same as دفتر معین above — the data exists (`getAccountDrillDown`, `v_ledger_by_account`), the reporting surface doesn't name or format it as a standalone گردش حساب statement |

**Wave 1 conclusion for §1:** the *mechanics* of double-entry accounting are sound and tested (899+
unit tests, 300+ integration tests at last count in Phase 21's progress log). What's missing is the
**explicit standards vocabulary layered on top of the mechanics** — level classification, nature/
contra flags, and named report surfaces for دفتر کل/دفتر معین/گردش حساب. None of this requires
touching the ledger's posting logic; it's additive metadata and reporting, which is exactly why it's
scoped as its own core-engine wave (see §8, Wave 2) rather than a rewrite.

## 2. Account structure sections (#160 §2) — mapped

Assets/liabilities/equity/revenue/expense/COGS/inventory/fixed-assets/depreciation/reserves/
suspense/clearing accounts:

| Item | Status |
|---|---|
| دارایی‌ها / بدهی‌ها / حقوق صاحبان سرمایه / درآمدها / هزینه‌ها | **Exists** — `AccountType` (`coa-template.ts`) |
| بهای تمام‌شده (COGS) | **Exists** — `cogs` (5100), `goldCogs` (5110), `COST_OF_SALES_CODES` groups material-cost-vs-overhead for a multi-step income statement |
| موجودی کالا (inventory) | **Exists** — `inventory` (1300, F&B), `goldInventory` (1320), full FIFO/weighted-average/NRV costing (Phase 6, `inventory-exact.ts` and friends) |
| دارایی ثابت (fixed assets) | **Gap** | `1500 اثاثه و تجهیزات` exists as one flat asset line; no fixed-asset register, no depreciation schedule/posting |
| استهلاک (depreciation) | **Gap** | No depreciation account, no depreciation posting path anywhere in `src/lib` |
| ذخایر (reserves/provisions) | **Partial** | `nrvAllowance` (1390) is a real provision account (inventory NRV write-down); no general-purpose "reserve" account type or pattern beyond that one case |
| حسابهای واسط (clearing/suspense — intermediary) | **Exists** | `bankClearing` (1120) is exactly this pattern for card/online payment settlement |
| حسابهای تعلیقی (suspense accounts, in the "uncategorized, to be resolved" sense) | **Gap** | No general suspense-account concept for miscategorized/pending postings |

**Wave 1 conclusion for §2:** fixed-asset register + depreciation is the one genuinely unbuilt
sub-domain here (everything else is either shipped or is a metadata/labeling gap, same class as §1).

## 3. Terminology control (#160 §3, and the added §9 UI/UX requirement)

Checked what Persian accounting vocabulary the product already uses (grep across `src/app/dashboard`
and `src/lib`):

- Correctly-used standard terms already in the UI: تراز آزمایشی (trial balance), دفتر روزنامه
  (journal — though see دفتر کل/معین gap above), صورت سود و زیان, ترازنامه, حساب‌های دریافتنی/
  پرداختنی, سند حسابداری (implicitly, via "ثبت سند دستی").
- Terms #160 explicitly calls out that are **not present anywhere**: معین، تفصیلی، ماهیت (نات),
  حساب کاهنده، حساب سیستمی (as a labeled concept), دفتر کل (as distinct from دفتر روزنامه), گردش
  حساب.
- No systematic terminology audit has ever been done — labels were written phase-by-phase, each
  phase choosing its own wording locally (reasonably, since no phase before #160 had "Persian
  accounting-standard terminology consistency" as an explicit goal).

**Gap:** a full label-by-label pass across every accounting-adjacent page (`/dashboard/ledger`,
`/accounting/reports`, `/accounting/inventory`'s costing surfaces, `/dashboard/jewelry`, the setup
wizard's `/setup/accounts` and `/setup/tax` steps) against professional Persian accounting
terminology has not been done. This is real, scoped work — not a rewrite, a review-and-relabel pass
— and per #160's own added requirement (comment, §9), it needs to happen **before every future wave's
PR**, not just once. Recommendation: fold it into Wave 2 as a one-time baseline pass, then treat it as
a standing checklist item on every subsequent wave (see §8).

## 4. Cafe/restaurant specialized accounting (#160 §4)

| Item | Status |
|---|---|
| فروش غذا / فروش نوشیدنی | **Exists in COA, not wired** — 4100/4200 are template rows but auto-posting sends every order to the general `salesRevenue` (4300) account; no `menu_categories` → account mapping exists (an explicit Phase 7 decision, revisited and left as-is — "Order revenue split" note in Phase 7 doc) |
| فروش بیرون‌بر (takeout) / ارسال (delivery) / پلتفرم‌های سفارش آنلاین (delivery platforms) / کمیسیون پلتفرم‌ها (platform commissions) | **Gap** | Phase 11 (Delivery) tracks couriers/delivery orders operationally, but nothing in the COA or posting rules splits delivery revenue from dine-in, and there is no platform-commission expense account or posting path at all |
| کارت‌خوان و تسویه‌ها (card settlement) | **Exists** | `bankClearing` (1120) |
| صندوق و شیفت (cash register & shift) | **Exists operationally** (Phase 4/5 `shift-service.ts`) **and reconciles to the ledger** (Phase 16 bank/cash reconciliation against `cash`/`bankClearing`). One caveat carried over from migration 0008's own comment: `v_shift_reconciliation` is a proxy built off order/payment data — there's no dedicated till/clock-in/clock-out entity backing it |
| انعام کارکنان (staff tips) | **Gap** | No tip field on an order, no tip liability/expense account. Confirmed by search — no tip concept anywhere in `src/lib` |
| مواد اولیه / دستور تولید (recipe costing) | **Exists** | Phase 6 `menu_item_ingredients`, recipe-based COGS |
| ضایعات (waste) | **Exists** | `wasteExpense` (5150), full posting path |
| کسری موجودی (inventory shortage) | **Exists** | `inventoryCountExpense` (5160), negative-layer shortage tracking |
| بهای تمام‌شده غذا / کنترل Food Cost | **Partial** | COGS is tracked exactly (FIFO/weighted-average); no dedicated "food cost %" report comparing actual vs. theoretical/recipe-standard consumption |
| کنترل مصرف واقعی و استاندارد (actual vs. standard consumption) | **Gap** | No variance report exists comparing recipe-standard ingredient usage to actual deducted stock |
| هزینه کارکنان / انرژی / اجاره / بازاریابی | **Exists** | 5200/5300/5400/5600 in the COA, postable via manual journal or (payroll) via `payroll-service.ts` |

**Wave 1 conclusion for §4:** the biggest real gaps are (a) revenue not split by sales channel
(dine-in/takeout/delivery/online-platform) or category, (b) no platform-commission or tip accounts,
and (c) no actual-vs-standard food-cost variance report. These map cleanly onto a "cafe/restaurant COA
depth" wave (see §8, Wave 4) — a template and posting-rule extension, not new core-engine work, since
Phase 21's posting-rule engine already exists to hang these on.

## 5. Jewelry/gold/watch/accessories accounting (#160 §5)

Already delivered by **Phase 21, Waves 1-4** (see §0 above): weight/purity, daily gold pricing,
making-charge/profit/VAT formula, stone cost add-ons, consignment posting with its own liability/
commission accounts, `/api/jewelry/*` + `/dashboard/jewelry`, and jewelry selectable at `/welcome`.

Remaining, already scoped as **Phase 21 Waves 5-7** (not yet built):

- Watch: serialized units, warranty, repair-ticket workflow (Phase 21 Wave 5)
- Accessories: variant management UI (Phase 21 Wave 6 — thin, since the variant primitive already
  exists from Wave 1)
- Specialized reports: weight reconciliation, consignment statements, warranty/repair reports,
  variant-level sales analysis, item-level audit trail (Phase 21 Wave 7)

Also explicitly still open per Phase 21's own doc: an external gold-price feed (provider TBD, hook
exists), paying out a consignor's payable balance + consignor statements, and weight-based FIFO lots
for bulk gold stock (today's `unit_cost_per_gram` is an average-cost simplification).

**Wave 1 recommendation:** #160's proposed "Wave 5: jewelry template" and "Wave 6: multi-industry
architecture" should not be re-run — they're Phase 21 Waves 1-4, done. #160's remaining industry work
is exactly Phase 21's own remaining Waves 5-7, which should continue under Phase 21's tracking rather
than being duplicated under #160. #160's real net-new contribution to this area is the terminology/
UX audit (§9) applied to the jewelry UI specifically, which Phase 21 never had as an explicit goal.

## 6. Multi-industry architecture (#160 §6)

Already delivered by **Phase 21 Wave 1**: `businesses.industry` (immutable, checked, defaulted),
domain-event log + posting-rule engine (`src/lib/posting-engine.ts`, `registerPostingRule`/
`emitDomainEvent`/`dispatchDomainEvent`), generic Item/Variant/Serial primitive
(`items`/`item_variant_attributes`/`item_serials`), industry-aware setup wizard
(`wizard-steps.ts`'s `wizardStepsForIndustry`).

**Gap:** the posting engine is proven (F&B waste posting rewired through it, jewelry's gold-sale rules
built directly against it) but most of F&B's own posting functions (order payment, COGS, purchases,
stock counts, AR/AP, payroll, expenses, closing) are still hand-written functions in
`ledger-service.ts`, deliberately not migrated onto the engine yet (a considered decision in Phase 21,
not an oversight — see its Wave 1 progress notes). This is fine as-is for two industries; if #160's
"Rules Engine" ask (§6) means every posting path should eventually be a registered rule, that's a
larger, lower-priority refactor with no product need behind it yet — flagged here, not recommended
for near-term scheduling.

## 7. Software changes needed (#160 §7) — the concrete Core Accounting Engine backlog

This is where §1/§2's metadata gaps turn into an actual implementation list for Wave 2:

### 7.1 Account hierarchy levels (گروه / کل / معین / تفصیلی)

`accounts` (migration 0001) has only `code`, `name`, `type`, `parent_id`, `is_active` — arbitrary
nesting depth via `parent_id`, no concept of which of the four standard Iranian-accounting levels a
given account sits at. Needed: an explicit `level` enum (`group` | `kol` | `moein` | `tafsili`) or
equivalent, validated so a `tafsili` account can't parent another `tafsili` account, etc. This is a
schema addition (new column + migration) plus updates to `accounts-service.ts`'s create/reparent
validation and the COA templates (`coa-template.ts`) to tag every existing row with its level.
Backward-compatible: existing `parent_id` nesting already roughly follows this shape (e.g. `1000` →
`1100` in `FNB_COA_TEMPLATE` is already a group→kol relationship), so this is largely a labeling
migration, not a restructuring one.

### 7.2 Account nature/behavior (Account Nature, Account Behavior, contra accounts)

Needed: an explicit, stored `normal_balance` (`debit` | `credit`) derived from `type` at creation
(asset/expense → debit, liability/equity/revenue → credit) but stored rather than re-derived ad hoc
in report code each time, plus an `is_contra` boolean for accounts like `salesReturns`/`nrvAllowance`
whose balance moves opposite their type's normal direction. This closes the "Account Metadata /
Account Nature / Account Behavior" item in §7's own list and lets reports (and the UI) show a
correct ↑/↓ or بدهکار/بستانکار badge per account without re-deriving it from `type` inline every time.

### 7.3 دفتر کل / دفتر معین / گردش حساب reporting

The underlying data (`getAccountDrillDown`, journal lines by account) already supports these; what's
missing is presenting them as their own named reports rather than only as a drill-down overlay on
top of P&L/Balance Sheet/trial-balance figures. Concretely: a per-account statement page (opening
balance, every movement in a date range, running balance, closing balance) reachable directly from
the chart-of-accounts tab, not only by clicking through a report line.

### 7.4 System-account labeling in the UI

`WELL_KNOWN_CODES` protection already exists at the service layer; the chart-of-accounts UI should
visibly badge a well-known account as "حساب سیستمی" wherever archive/delete is offered, rather than
only reactively rejecting the action.

### 7.5 Posting Rules / Validation / Audit Trail / Permission Control

- **Posting rules**: exists as the Phase 21 posting-rule engine for new (event-driven) postings;
  legacy F&B posting functions are hand-validated in `ledger-service.ts`/`ledger.ts`
  (`validateJournalLines`/`checkBalance`) — sufficient, no gap.
- **Journal Entry Engine**: exists (`postJournalEntry`/`postExactJournalEntry`).
- **Audit Trail**: `journal_entries.created_by`/`posted_at` exist; reversal linkage
  (`reverses_entry_id`/`reversed_at`/`reversed_by`) exists (Phase 16). No gap for the ledger itself.
  Whether a broader cross-module audit trail (who changed an account's name, who archived it) is
  wanted is a §7 open question worth confirming with the product owner before scheduling — `accounts`
  has no history table today, only current state.
- **Permission Control**: exists and is granular (`PERMISSIONS.ledgerApprove`, `accountsEdit`,
  role gating throughout Phase 16). No gap.

## 8. Recommended wave sequencing (revises #160 §8)

Given the audit above, re-sequencing #160's own 7-wave plan to avoid redoing Phase 21's shipped work
and to order the real gaps by dependency:

1. **Wave 1 (this document)** — audit + gap analysis. Done.
2. **Wave 2 — Core Accounting Engine metadata.** §7.1 (account levels), §7.2 (nature/contra flags),
   §7.4 (system-account UI badge). Schema-additive, no behavior change to existing postings — the
   lowest-risk, foundational wave, and a prerequisite for Wave 3's terminology pass having something
   correct to label.
3. **Wave 3 — Terminology & UI/UX standards audit (closes #160 §3 and §9).** A full label-by-label
   pass across every accounting-adjacent page, using the vocabulary Wave 2 makes available (level
   names, nature). Establishes the baseline; #160's own §9 requirement ("before every future wave's
   PR") then applies going forward as a checklist, not a one-time deliverable.
4. **Wave 4 — Cafe/restaurant COA depth (closes #160 §4's remaining gaps).** Revenue split by channel
   (dine-in/takeout/delivery/platform) and category, platform-commission and tip accounts + posting
   rules (built as registered rules against Phase 21's posting engine, not new hand-written
   `ledger-service.ts` functions), and an actual-vs-standard food-cost variance report.
5. **Wave 5 — دفتر کل/معین/گردش حساب reporting (closes §7.3), fixed assets & depreciation (closes
   the §2 gap).** Two independent, reporting-and-schema-additive slices; can run as one wave or split
   if either grows large enough to warrant its own PR.
6. **Continue Phase 21 Waves 5-7** (watch, accessories, specialized industry reports) under Phase
   21's own tracking — not duplicated as a new #160 wave, per §5/§6 above.
7. **Regression/migration/documentation pass** — once Waves 2-5 land, re-run the full suite
   (`npx tsc --noEmit`, `npm test`, `npm run test:db`, `npm run build`), confirm `tenant-isolation`
   picks up any new tables automatically, and update this phase doc's "Progress" section per the
   project's normal phase-doc convention.

Each wave still gets its own PR, its own full local test run before that PR, and (per #160's added
§9 requirement) its own terminology/UI review before being called done — exactly as #160's "قوانین
اجرا" (execution rules) require.

## Exit criteria (for Wave 1 specifically)

- [x] Every #160 scope item (§1-§7) mapped to either "exists" (with file/line evidence), "partial gap",
  or "gap".
- [x] Every apparent gap checked against Phase 21's own documented roadmap first, to avoid
  double-counting already-planned work as new #160 scope.
- [x] A concrete, dependency-ordered backlog for Waves 2+ that a future PR can pick up directly
  without re-deriving this analysis.

## Open questions for the product owner (carried into Wave 2+)

1. §7.1's account-level model: is the 4-tier گروه/کل/معین/تفصیلی distinction needed as enforced
   structure (a `tafsili` account literally cannot parent another `tafsili`), or as descriptive
   metadata only (a label with no new constraint)? **Answered by Wave 2 (below): enforced structure**
   — the same discipline every other invariant in this codebase uses (reject at the boundary, don't
   just describe).
2. §4's revenue-channel split: should dine-in/takeout/delivery/platform revenue split be per-order
   (requires an order-level channel field, which may already partially exist via Phase 11's delivery
   flag — needs confirming) or is a coarser split acceptable for v1? **Answered by Wave 4: per-order,
   off the existing `orders.type`** — no new field was needed; the "platform" half (a third-party
   marketplace, distinct from in-house delivery) is still open — see Wave 4's own "not yet built" note.
3. §7.5's audit-trail question: is a full change-history table for `accounts` (who renamed/archived/
   reparented, and when) in scope, or is current-state-only sufficient? **Answered by Wave 11: yes,
   build it** — not as a dedicated `accounts` history table, though; see Wave 11 below for why the
   existing `audit_log` table already covers this shape.

## Progress

**Wave 1 — audit & gap analysis — implemented.** This document, as originally written (sections
0-8 above). No code changes.

**Wave 2 — Core Accounting Engine metadata — implemented**, covering §7.1 (account hierarchy
levels), §7.2 (debit/credit nature + contra flag), and §7.4 (system-account UI badge):

- **Account levels (گروه/کل/معین/تفصیلی)** — `migrations/0056_account_hierarchy_nature.sql` adds
  `accounts.level` (a new `account_level` enum), backfilled for every existing account by actual
  parent-chain depth (a recursive CTE, not a flat "root vs. everything else" guess). `coa-template.ts`
  gained `AccountLevel`, `nextAccountLevel(parentLevel)` (the pure level-transition rule: `null` →
  `group`, `group` → `kol` → `moein` → `tafsili`, and `null` past `tafsili` — a تفصیلی account can't
  have children), and `ACCOUNT_LEVEL_LABELS`. Enforced, not just descriptive (resolving open question
  1 above): `accounts-service.ts`'s `createAccount`/`reparentAccount` both compute the correct level
  from the chosen parent and reject with `parent_too_deep` if the parent is already `tafsili`;
  `reparentAccount` also cascades the new level down every existing descendant
  (`cascadeDescendantLevels`, a BFS walk in the same transaction) and rejects the whole move with
  `hierarchy_too_deep` if any descendant would need to sit past `tafsili`. The three chart-of-accounts
  seeding/replace call sites (`business-provisioning.ts`'s `seedChartOfAccounts`, `/api/setup/accounts`
  POST, `/api/settings/accounts` PUT) compute each row's level the same way, in the same parent-first
  topological insertion order they already used.
- **Debit/credit nature (ماهیت بدهکار/بستانکار)** — `accounts.normal_balance` is a `GENERATED ALWAYS
  AS (...) STORED` column derived directly from `type` (asset/expense → debit, liability/equity/
  revenue → credit), not a value any code path sets — this guarantees it's always correct for every
  insertion path, including the dozens of raw-SQL account fixtures across the existing test suite,
  with no code changes required anywhere else and no risk of drifting from `type`. `coa-template.ts`
  gained `normalBalanceForType(type)`, the same mapping the generated column encodes in SQL, exposed
  for display/reporting code.
- **Contra accounts (حساب‌های کاهنده)** — `accounts.is_contra` (plain boolean, default `false`).
  `TemplateAccount` gained an optional `isContra` field; the F&B template's «برگشت از فروش» (4400) and
  «ذخیره کاهش ارزش موجودی» (1390) are marked `isContra: true` (backfilled onto every existing business
  by the same migration, matched by code — the same pattern migrations 0025/0032 used). `createAccount`
  accepts an optional `isContra` param for ad hoc sub-accounts.
- **System-account badge (§7.4)** — `chart-of-accounts-section.tsx` now shows a level column, a
  ماهیت column (بدهکار/بستانکار, with a «(کاهنده)» suffix for a contra account), and a «سیستمی» badge
  next to any account whose code is in `WELL_KNOWN_CODES` — previously this protection only surfaced
  reactively, as an error message when an archive/delete was rejected. The add-account form gained a
  «حساب کاهنده» checkbox and shows each candidate parent's level in its picker.
- **A pre-existing bug this wave's own migration exposed, fixed alongside**: `tenant-export.ts`'s
  `exportTenantData` built its per-table column list from `SELECT *`, which includes generated
  columns — Postgres refuses an explicit `INSERT` into one, so the moment `accounts` gained a
  generated `normal_balance` column, every per-business SQL backup/restore round-trip involving an
  account broke (`integration/tenant-export.integration.test.ts` caught this immediately). Fixed
  generically, not with an `accounts`-specific special case: `exportTenantData` now reads
  `information_schema.columns.is_generated` once per export and excludes any generated column from
  the table's column list — correct for `accounts.normal_balance` today and for any future generated
  column on any table, with no per-table maintenance needed.
- Verified in `src/lib/coa-template.test.ts` (`nextAccountLevel`'s four transitions plus the
  past-تفصیلی `null` case, `normalBalanceForType`'s full mapping, and that exactly the two intended
  F&B accounts are marked contra) and extended `integration/chart-of-accounts.integration.test.ts`
  (a four-level create chain assigns group/kol/moein/tafsili correctly; creating a child under a
  تفصیلی account is rejected; reparenting cascades the new level through a multi-level subtree;
  reparenting that would push a descendant past تفصیلی is rejected and rolled back; clearing an
  account's parent resets it and its descendants back down; normal balance is stored correctly for
  all five account types; an explicit `isContra` flag persists and defaults to `false`). `npx tsc
  --noEmit`, `npm test` (951 tests, up from 943), `npm run db:migrate` (twice, confirmed a no-op the
  second time) + `npm run test:db` (310 tests, `tenant-isolation`'s 19 tests re-confirming RLS
  unaffected by the new columns), and `npm run build` all pass.

Not yet built (left for a later wave, not blocking Wave 2's own exit): §3/§9's full terminology/UI-UX
audit (Wave 3 in the recommended sequencing above), §7.3's dedicated دفتر معین/گردش حساب statement
page, §4's cafe/restaurant COA depth (revenue-channel split, platform-commission/tip accounts,
food-cost variance report), and §2's fixed-asset/depreciation gap. The setup-wizard step
(`/setup/accounts`) and the settings-page chart editor (`accounts-settings.tsx`) don't yet expose the
`isContra` checkbox the way the ledger's ongoing chart-of-accounts management tab does — intentional
for this slice (those two are one-time/bulk template editors; `isContra` defaults to `false` and stays
editable afterward through the ledger tab), flagged here in case a future wave decides otherwise.

**Wave 3 — Terminology & UI/UX standards audit — implemented**, closing §3 and the epic's §9
requirement: a label-by-label pass across every accounting-adjacent dashboard page
(`/dashboard/ledger` except the already-correct `chart-of-accounts-section.tsx`, `/accounting/reports`,
`/dashboard/jewelry`, the costing-adjacent parts of `/accounting/inventory`, `/setup/accounts`,
`/setup/tax`, `src/app/dashboard/settings/accounts-settings.tsx`). Result: the vocabulary was already
correct and consistent almost everywhere (سند/دفتر روزنامه/تراز آزمایشی/تأیید/بدهکار-بستانکار/
حساب‌های دریافتنی-پرداختنی/صورت گردش وجوه نقد all checked across every file they appear in and found
consistent) — the one real inconsistency found was the «equity» account-type label: `chart-of-
accounts-section.tsx` and `trial-balance-section.tsx` already said «حقوق صاحبان سرمایه», but
`accounts-settings.tsx` said «حقوق مالکانه» and `setup/accounts/page.tsx` said «سرمایه». Both fixed to
match. New `docs/accounting-terminology.md` records the standard-term reference table and the
terminology-validation checklist §9 asks every future wave's PR to run before opening.
No component logic, prop names, function signatures, API contracts, or `coa-template.ts` account
names/codes were touched — string-literal label changes only. `npx tsc --noEmit`, `npm test` (951
tests, unchanged — no test-affecting code changed), `npm run test:db` (310 tests), and `npm run
build` all pass.

**Wave 4, first slice — revenue split by sales channel + platform-commission expense account —
implemented**, closing part of §4's gap. Two scoping decisions made before writing any code:

1. **Revenue-channel split reuses `orders.type` (dine_in/takeaway/delivery) — no new schema.** §1's
   open question ("does an order-level channel field already exist") is answered: it's existed since
   Phase 0's foundation migration, just never wired into auto-posting (Phase 7 explicitly left this
   as a documented future step). This made the split additive to the *posting* layer only, not a
   checkout/order-model change.
2. **Tips (انعام) and the food-cost variance report are deliberately deferred, not built in this
   slice.** Both need real product decisions this audit can't make unilaterally: a tip has no
   existing capture point anywhere in the schema (unlike channel, which `orders.type` already
   provided) — adding one means deciding whether it's collected on top of `orders.total` or folded
   into it, which touches the single most sensitive transaction in the codebase (checkout/payment,
   `/api/orders/[id]/pay`) for a feature with no settled design yet. A food-cost variance report
   (actual vs. recipe-standard consumption) is a substantial reporting feature in its own right, not
   a labeling or account-mapping change. Flagging both as their own follow-up slice rather than
   guessing at checkout-flow behavior changes without a migration plan, per the project's own rule.

What shipped:

- **Three new revenue accounts** (`migrations/0057_channel_revenue_platform_commission.sql`,
  `coa-template.ts`): `dineInRevenue` (4310, «فروش حضوری (سالن)»), `takeawayRevenue` (4320, «فروش
  بیرون‌بر»), `deliveryRevenue` (4330, «فروش ارسالی») — siblings of the existing flat `salesRevenue`
  (4300) under «4000 درآمدها», which stays in the template for historical entries but stops receiving
  new auto-postings. Backfilled onto every existing `food_service` business only (a jewelry business's
  chart has no dine-in concept); unlike migrations 0017/0025/0032's precedent of leaving a backfilled
  well-known account parent-less, this backfill sets `parent_id`/`level` (`'kol'`) correctly — worth
  doing properly now that Wave 2 made `level` a real, queryable concept. `getProfitAndLoss`
  (`reports-service.ts`) needed no change: it already lists revenue accounts flatly and sums by
  `type`, not by hierarchy, so three accounts instead of one just show as three P&L lines with the
  same correct total.
- **`platformCommissionExpense`** (5650, «کارمزد پلتفرم‌های سفارش آنلاین») — a new well-known expense
  account for §4's "کمیسیون پلتفرم‌ها", settled via the existing manual-journal workflow rather than
  wired into order payment — the same "new account, not deep posting-path integration" pattern Phase
  16 used for input VAT (decision 19 in that phase's doc), since there's no "platform" order-source
  concept in the schema to auto-post against yet.
- **`src/lib/ledger.ts`** gained `revenueAccountCodeForOrderChannel` (pure: `orders.type` → the
  matching well-known code) and an `OrderChannel` type. **`postExactOrderPaymentEntry`**
  (`ledger-service.ts`) — the live posting path `/api/orders/[id]/pay` calls — now takes an
  `orderChannel` param and credits the channel-specific account instead of the flat `salesRevenue`;
  everything else about the entry (debit account by payment method, VAT line, balance) is unchanged.
  `src/lib/order-lock.ts`'s `lockOpenOrder` (used by every order-mutation route) now also selects
  `orders.type`, purely additive for its other two callers. The legacy plain-number
  `buildOrderPaymentLines`/`postOrderPaymentEntry` path (dead code — no live caller, per a grep
  confirming this before touching anything) was deliberately left untouched.
- Verified in `src/lib/ledger.test.ts` (`revenueAccountCodeForOrderChannel`'s three-way mapping) and
  new `integration/order-payment-channel-revenue.integration.test.ts` (each of the three channels
  credits its own account with the exact expected amounts, the entry stays balanced regardless of
  channel, and a business missing the channel's account still gets the standard
  `MissingLedgerAccountError` → `409` treatment). Also manually verified the migration's backfill
  logic against a hand-built pre-existing business (correct `parent_id`, `level = 'kol'`,
  `normal_balance` auto-derived, `is_contra = false`). `npx tsc --noEmit`, `npm test` (952 tests, up
  from 951), `npm run db:migrate` (twice, second run a no-op) + `npm run test:db` (315 tests, up from
  310, `tenant-isolation`'s 19 tests re-confirming RLS unaffected), and `npm run build` all pass.

Not yet built (this slice's deliberate deferrals, see above): tip capture (needs a checkout-flow
product decision), the food-cost variance report, and any actual "online platform" order-source
concept (§4 asks for "پلتفرم‌های سفارش آنلاین" as its own thing, distinct from in-house delivery —
Phase 11's `couriers`/`deliveries` model is entirely in-house-courier-based with no third-party
marketplace concept; `platformCommissionExpense` gives a place to *record* the cost, not a way to
*capture* which platform or auto-post a commission split at sale time).

**Wave 5, first slice — دفتر معین/گردش حساب (account statement) — implemented**, closing §7.3.
Scoped to this one report rather than bundling it with §2's fixed-asset/depreciation gap (the wave's
other stated item): the two are unrelated (pure reporting on existing data vs. a new asset-register
subsystem with its own posting), and keeping them as separate slices matches every other multi-part
wave in this project's history.

- **`getAccountStatement`** (`reports-service.ts`) — one account's full ledger for a period: an
  opening balance (net movement before `dateFrom`, `0` if `dateFrom` is omitted), every line
  chronologically (oldest first, unlike `getAccountDrillDown`'s newest-first flat list for one report
  figure) with a running balance, and a closing balance. The running balance is signed off the
  account's stored `normal_balance` (Wave 2) — `balance += (debit − credit)` for a debit-normal
  account, `(credit − debit)` for a credit-normal one — the same convention `getProfitAndLoss`/
  `getBalanceSheet` already use per `account.type`, now read directly off the column instead of
  re-derived inline. Returns `null` for an unknown or cross-business account id.
- **`GET /api/ledger/accounts/[id]/statement`** (`?dateFrom=&dateTo=`) — same read access as the rest
  of the ledger surface (owner/manager/accountant).
- **`AccountStatementPanel`** (new, mirroring `ar-statement-panel.tsx`'s modal shape) — opening
  balance, a running-balance table/card list, closing balance, with `JalaliDatePicker` range inputs
  (`vat-report-section.tsx`'s pattern). Reached via a new «گردش حساب» button on every row of the
  chart-of-accounts tab (`chart-of-accounts-section.tsx`), per the gap analysis's own recommendation
  ("reachable directly from the chart-of-accounts tab, not only by clicking through a report line") —
  no new tab, no change to the existing drill-down overlay.
- No schema change — pure reporting on data every posting path already writes.
- Verified in extended `integration/financial-statements.integration.test.ts` (null for a
  cross-business account; correct running balance and chronological ordering for a credit-normal
  revenue account and a debit-normal expense account, including out-of-insertion-order dates;
  `openingBalance` correctly carrying pre-range movement into a bounded query while only in-range
  lines appear; and the zero-activity case). `npx tsc --noEmit`, `npm test` (954 tests — no new
  pure-unit coverage needed, since `reports-service.ts` is DB-touching and covered by integration
  tests per repo convention), `npm run db:migrate` (no new migration this slice) + `npm run test:db`
  (320 tests, up from 315), and `npm run build` all pass.

Not yet built: §2's fixed-asset register and depreciation (Wave 5's other item, deferred to its own
slice — a new subsystem with its own schema and posting, not a reporting change).

**Wave 5, second slice — fixed-asset register & depreciation — implemented**, closing §2's gap.
Straight-line only for v1 (the simplest default, matching every other phase's "start simple, revisit
if asked" pattern) — no declining-balance/units-of-production methods and no disposal/sale-of-asset
workflow yet.

- **`fixed_assets`** (`migrations/0058_fixed_assets_depreciation.sql`) — name, acquisition date, cost,
  salvage value, useful life in months. **`fixed_asset_depreciation_entries`** — one row per posted
  period for one asset, `UNIQUE(fixed_asset_id, period_label)` guarding against posting the same
  period twice (stricter than `payroll_runs`' free-text label, which has no such guard — a
  depreciation amount is fully deterministic, so there's no legitimate reason to repeat one). Both
  RLS-scoped in the same migration, mirroring `consignors`/`payroll_runs`'s exact policy shape.
  `accumulatedDepreciation`/`bookValue` are never stored on the asset row — always reconstructed from
  `fixed_asset_depreciation_entries`, the same "never a shadow copy" discipline AR/AP/VAT already use
  for their control-account balances.
- **Two new well-known accounts**, backfilled onto every existing `food_service` business (same
  scoping as Wave 4's channel-revenue accounts — jewelry stays out of scope): `accumulatedDepreciation`
  (1510, «استهلاک انباشته», contra-asset, a `moein`-level child of `1500 اثاثه و تجهیزات` — the only
  fixed-asset line the template has today) and `depreciationExpense` (5700, «هزینه استهلاک»).
- **`src/lib/depreciation.ts`** (pure) — `validateFixedAsset`, `monthlyDepreciation` (depreciable base
  ÷ useful life, rounded to whole Rial), and `depreciationForPeriod(asset, accumulatedSoFar,
  periodsPostedSoFar)`. A real rounding bug surfaced and got fixed while writing this: a flat
  per-period rounded amount (e.g. 100,000 over 3 months → 33,333/month) leaves a few Rial of the
  depreciable base permanently unposted (33,333 × 3 = 99,999, one short) unless the *last scheduled*
  period absorbs the remainder instead of applying the regular monthly amount — `periodsPostedSoFar`
  exists specifically so the function can detect "this is the final period" and sweep up that
  rounding dust, proven in both the pure unit test and an integration test posting all three periods
  of a real asset and checking they sum to exactly the depreciable base.
- **`src/lib/fixed-assets-service.ts`** — `createFixedAsset`/`listFixedAssets`/`deleteFixedAsset`
  (only for an asset with zero depreciation posted — otherwise archive-equivalent doesn't apply since
  there's no archive concept here, just "can't delete history") and `postDepreciation` (computes the
  period's amount from what's already accumulated, inserts the depreciation-entry row, and posts
  Debit `depreciationExpense` / Credit `accumulatedDepreciation` via the standard `postJournalEntry` +
  `accountIdsByCode` pair every other well-known-code posting path uses — so it's subject to the
  fiscal-period lock exactly like everything else). A duplicate `periodLabel` surfaces as the DB's own
  unique-constraint violation, caught and re-thrown as a clean `period_already_depreciated` error
  rather than a raw Postgres exception.
- **`/api/ledger/fixed-assets`** (list/create), **`/api/ledger/fixed-assets/[id]`** (delete),
  **`/api/ledger/fixed-assets/[id]/depreciate`** (post one period) — owner/manager/accountant, the
  standard "post immediately" ledger-surface gate (AR receive-payment, AP pay-bill, expenses,
  reconciliation), not payroll's narrower owner+accountant-only gate, since asset depreciation isn't
  compensation-sensitive data. (Update, issue #835: payroll's gate is now the `payroll.view` / `payroll.manage` capabilities — see [docs/payroll.md](../payroll.md).)
- **A new «دارایی‌های ثابت» tab** (`fixed-assets-section.tsx`) in the ledger dashboard — register an
  asset, see its cost/salvage/accumulated-depreciation/book-value, and post a period's depreciation
  inline per row. Uses its own local error-message map + direct `api()` calls rather than the shared
  `run()` helper, matching `chart-of-accounts-section.tsx`'s precedent for a multi-action component
  that needs several distinct, specific error messages (not `expense-section.tsx`'s single-action
  `run()` pattern).
- Verified in `src/lib/depreciation.test.ts` (17 tests: validation, the monthly-amount formula,
  regular-vs-final-period behavior including the rounding-remainder case, zero once fully depreciated)
  and new `integration/fixed-assets.integration.test.ts` (9 tests: a fresh asset has zero accumulated
  depreciation and book value = cost; depreciation posts the exact expected balanced entry against the
  right two accounts; `listFixedAssets` correctly reflects posted depreciation; the same period can't
  be posted twice, and a rejected attempt leaves no stray journal entry; three periods of a
  100,000-over-3-months asset sum to exactly 100,000 and a fourth is refused as `fully_depreciated`;
  posting into a locked fiscal period is refused exactly like every other posting path; delete
  succeeds only with zero depreciation posted). Also manually re-verified the migration's backfill
  (correct `parent_id`/`level = 'moein'`/`is_contra = true` for `accumulatedDepreciation`) against a
  hand-built pre-existing business, same as Wave 4. `npx tsc --noEmit`, `npm test` (977 tests, up from
  954), `npm run db:migrate` (twice, second run a no-op) + `npm run test:db` (329 tests, up from 320,
  `tenant-isolation`'s generated policy checks covering both new tables automatically), and `npm run
  build` all pass.

Not yet built: asset disposal/sale, declining-balance or other depreciation methods, and a
depreciation-schedule *report* (a forward-looking projection of remaining periods/amounts, distinct
from the register's current-state view) — none blocked exit criteria for this slice, all reasonable
follow-ups if asked for.

With this, Wave 5 as scoped in the gap analysis (§7.3 + §2) is complete.

**Wave 7 — regression pass & documentation wrap-up — implemented.** §8's own sequencing put this
last, after Waves 2-5 land: a full re-verification of the whole suite on top of everything those
waves shipped (not just each wave's own pre-PR check, which only ever proved that wave in isolation
against main at the time), plus closing out this document's own bookkeeping now that the epic's
tractable, unambiguous scope is done.

- Re-ran the complete verification suite against `main` with Waves 2-5 already merged: `npx tsc
  --noEmit`, `npm test` (977 tests), `npm run db:migrate` (a no-op — every migration through 0058 was
  already applied and stayed applied, confirming no wave's migration silently conflicted with
  another's), `npm run test:db` (329 tests across all 41 integration files, not just the ones touched
  by any single wave), and `npm run build` — all clean. No regressions between waves.
- Updated the "open questions for the product owner" list above with what Wave 4 actually answered
  (the revenue-channel question) versus what's still genuinely open (§7.5's audit-trail question,
  untouched by any wave).

**Epic #160 status at this point** — everything in the gap analysis that was answerable without a
new, unconfirmed product decision has shipped:

| Wave | Scope | Status |
|---|---|---|
| 1 | Audit & gap analysis | Done |
| 2 | Account hierarchy levels, debit/credit nature, contra flag | Done |
| 3 | Terminology & UI/UX standards audit + standing checklist | Done |
| 4 | Revenue split by sales channel + platform-commission account | Done (first slice — see below for what's deferred) |
| 5 | Account statement (دفتر معین/گردش حساب) + fixed-asset register/depreciation | Done |
| 7 | Regression pass & doc wrap-up | Done (this entry) |
| 8 | Tip capture (انعام کارکنان) | Done (see below) |
| 9 | Food-cost variance report | Done (see below) |
| 10 | Online ordering platform commission (SnapFood) | Done (see below) |
| 11 | Account change-history / audit-trail (§7.5) | Done (see below) |

**Wave 8 — tip capture (انعام کارکنان, §4) — implemented.** Picked up as the first of the three
deliberately-deferred items above, once the product owner confirmed the three open questions Wave 4
flagged:

1. **Collected as a separate field added on top of the bill at checkout** (not folded into
   `orders.total`) — `orders` gets its own `tip_amount` column rather than the tip riding inside the
   existing total.
2. **Treated as a pass-through liability owed to staff, not revenue** — not subject to VAT, and not a
   business inflow.
3. **Pooled only for v1** — one amount per order, no per-staff attribution/split.

What shipped:

- **`orders.tip_amount bigint NOT NULL DEFAULT 0 CHECK (tip_amount >= 0)`** and a new well-known
  liability account (`migrations/0059_tip_capture.sql`, `coa-template.ts`): `tipsPayable` (2400,
  «انعام پرداختنی»), parented under «2000», `level = 'kol'`. Backfilled onto every existing
  `food_service` business only, same `ON CONFLICT (business_id, code) DO NOTHING` pattern as every
  prior well-known-account migration; added to `FNB_COA_TEMPLATE` only, not the jewelry template.
- **`postExactOrderPaymentEntry`** (`ledger-service.ts`) takes an optional `tip` param. When a tip is
  present, the debit (cash/bank/AR) line grows by the tip amount and a new credit line posts to
  `tipsPayable` — the tip never touches a revenue account and isn't part of the VAT base. `tipsPayable`
  is only requested from `accountIdsByCode` when the tip is non-zero, so a zero-tip payment still works
  on a business that hasn't been backfilled with the account (e.g. a future non-`food_service`
  industry).
- **`/api/orders/[id]/pay`** accepts `tipAmount` (Rial, validated as a non-negative safe integer),
  stores it on the completing order, and passes it through to the posting call.
- **Checkout UI** — both `order-detail.tsx` (the standard order page) and `pos-screen.tsx` (the
  touch-optimized quick-checkout screen, desktop and mobile panels) gained an optional tip input
  (entered in Toman, like every other money input in these screens) and show the tip and a combined
  "مبلغ دریافتی" total in their payment-confirmation step.
- **Receipt** (`receipt-template.ts`) gained an optional `tip` field on `ReceiptData`, rendering an
  «انعام» row and a «مبلغ دریافتی» (amount received = total + tip) row only when a tip was collected.
- Verified in `src/lib/receipt-template.test.ts` (tip row present/absent) and a new `describe` block
  in `integration/order-payment-channel-revenue.integration.test.ts` covering: the no-tip path is
  unchanged; a tip debits bill+tip and credits `tipsPayable`, not revenue; the entry stays balanced
  with a tip; a zero-tip payment still works on a business without `tipsPayable` configured; a
  non-zero tip on such a business fails with the standard `MissingLedgerAccountError` → `409`
  treatment. Also manually verified end-to-end against a live running instance — both via direct API
  calls and a real browser-driven checkout — confirming the posted entry for an 850,000 Rial bill with
  a 30,000 Rial tip: debit صندوق (Cash) 880,000, credit فروش بیرون‌بر (Takeaway Revenue) 850,000,
  credit انعام پرداختنی (Tips Payable) 30,000 — balanced, tip correctly excluded from revenue. `npx
  tsc --noEmit`, `npm test` (979 tests, up from 977), `npm run db:migrate` (twice, second run a
  no-op) + `npm run test:db` (334 tests, up from 329), and `npm run build` all pass.

Not yet built (the other deliberate deferral from Wave 4/7, unchanged): a genuine "online ordering
platform" concept — see below.

**Wave 9 — food-cost variance report (§4) — implemented.** Unlike tip capture, this deferral didn't
turn on an open product question — §4 already asked for "actual vs. recipe-standard consumption" —
it was deferred for being a genuinely separate reporting feature, not a small addition to an existing
one. Two scoping decisions, made here rather than guessed at in code, because the data model doesn't
support a more ambitious version without fabricating an allocation:

1. **"Theoretical" is read straight off `order_item_inventory_snapshots`** — the same frozen
   per-order-item ingredient requirements `deductForOrder` itself consumes from (recipe +
   modifier deltas already summed, captured at time of sale) — priced at each ingredient's *current*
   `avg_cost`. That answers "what should this have cost to make, at today's ingredient prices,"
   per menu item, without re-deriving `menu_item_ingredients`/`modifier_ingredients` combinatorially.
2. **"Actual" is a period total only, never a per-item figure.** `deductForOrder` posts one COGS
   consumption per *order* per ingredient, aggregated across every item in that order — the real
   FIFO/weighted-average lot cost genuinely can't be attributed back to one menu item in a
   multi-item order without prorating, and this report doesn't fabricate that split. So the actual
   side is the real posted ledger total for the period (COGS `5100` + waste `5150`, matching the P&L's
   own figures exactly), compared against the *sum* of the theoretical per-item figures — a period-
   level variance, not a per-item one. `unexplainedVariance` backs out the *already-tracked* waste
   account from that gap, isolating the portion price drift/portioning/theft would explain.

What shipped:

- **`buildFoodCostVariance`** (`reports.ts`, pure/unit-tested) takes per-item
  `{menuItemId, menuItemName, unitsSold, theoreticalCost, revenue}` plus the period's actual COGS and
  waste totals, and computes each item's food-cost % (`theoreticalCost / revenue`, sorted worst
  first), the period's `theoreticalCost`/`actualCogs`/`wasteCost`/`actualTotalCost`, and
  `variance`/`variancePct`/`unexplainedVariance`.
- **`getFoodCostVariance`** (`reports-service.ts`) — one query sums units sold and revenue per menu
  item from `order_items` (completed orders, non-voided items, optional date range/location); a
  second sums `required_quantity × order quantity × current avg_cost` from
  `order_item_inventory_snapshots`, grouped by `source_menu_item_id`; a small new
  `ledgerAccountCodeTotals` helper (alongside the existing `ledgerAccountTotals`) gets the COGS/waste
  ledger totals. An item sold with no snapshot rows (no recipe configured) still shows up with a
  0 theoretical cost — a visible "this item has no recipe" signal rather than being silently dropped.
- **`food_cost_variance`** added to `STANDARD_REPORTS` (`view: null`, computed directly — the same
  treatment as P&L/Balance Sheet/Cash Flow) and wired into
  `/api/reports/standard/[key]` and a new `FoodCostVarianceView` (`ledger-report-view.tsx`), following
  the existing ledger-report UI pattern (`standard-reports-section.tsx`'s `LEDGER_KEYS`).
  Deliberately out of v1 scope, and not silently half-built: period comparison (`?compare=1`) and CSV/
  Excel/PDF export aren't implemented for this report — the UI gates both off explicitly
  (`COMPARABLE_LEDGER_KEYS`, the `food_cost_variance` guard around `ExportButtons`) rather than
  showing controls that would silently no-op.
- Verified in `src/lib/reports.test.ts` (`buildFoodCostVariance`: per-item %, sort order, null-revenue
  handling, the actual-vs-theoretical/unexplained-variance arithmetic) and a new
  `integration/food-cost-variance.integration.test.ts` (theoretical pricing at current `avg_cost`
  against a real snapshot + ledger fixture; date-range and voided-item exclusion; an item with no
  recipe still lists at 0 theoretical cost; worst-food-cost-% sort order; an empty period returns
  zeroed totals). Also manually verified end-to-end in a live running instance — real order/recipe/
  ledger fixtures seeded directly, browser-driven navigation to the report — confirming the rendered
  numbers match the fixture exactly (a ۸,۱۰۰ تومان theoretical cost against ۹,۰۰۰ تومان actual COGS +
  ۵۰۰ تومان waste, ۱,۴۰۰ تومان variance, ۹۰۰ تومان unexplained, ۱۷.۳٪ variance). `npx tsc --noEmit`,
  `npm test` (983 tests, up from 979), `npm run db:migrate` (twice, second run a no-op — this wave
  added no migration) + `npm run test:db` (340 tests, up from 334), and `npm run build` all pass.

**Wave 10 — online ordering platform commission, SnapFood (§4) — implemented.** The last item in §4,
closed once the business owner answered the open questions Wave 9 (and Wave 4 before it) left
unresolved:

1. **Only SnapFood, for now** — no generic multi-platform abstraction built ahead of a second
   platform actually existing.
2. **Commission varies by contract**, so it's a business-configurable setting, not a hardcoded rate.
3. **No automated order feed.** SnapFood's PartnerFood app has no documented API or local
   integration surface (checked — nothing publicly indexed, and asking SnapFood directly is the
   owner's own next step if they want one later). A SnapFood order is entered the same way every
   other order already is: the cashier picks "اسنپ‌فود" as the payment method at checkout, exactly
   like cash/card/credit — no new order-intake concept, no fabricated integration.
4. **Auto-post at time of sale** (not a manual monthly journal entry) — the same posting-time
   pattern Wave 4/8 already established for revenue-channel splitting and tips, rather than the
   older "new account, settled manually" pattern Phase 16/Wave 4 used before those existed.

What shipped:

- **New well-known asset account `platformReceivable`** (1230, «مطالبات از پلتفرم‌های سفارش آنلاین»,
  `migrations/0060_online_platform_commission.sql`), backfilled onto existing `food_service`
  businesses, same pattern as every other Wave 4/5/8 account addition. The same migration adds
  `'snappfood'` to the `payment_method` Postgres enum — `payments.method` is a real enum column, not
  just an app-level string, so the payment-method list needed extending at the schema level too, not
  only in `ledger-service.ts`'s validation.
- **`postExactOrderPaymentEntry`** (`ledger-service.ts`) takes an optional `platformCommission`
  (Rial, resolved by the caller — same shape `tip` already uses). With `method: "snappfood"`, the
  debit splits: `platformReceivable` for the net amount (bill + tip − commission), and the existing
  `platformCommissionExpense` (5650, added in Wave 4) for the commission itself — SnapFood never
  hands over that slice, so it was never really "received." `platformCommission > 0` is rejected for
  any other method.
- **`SETTING_KEYS.onlinePlatforms`** + `online-platforms-service.ts` — `{ snappfood: { commissionPercent } | null }`,
  business-wide, `null` until an owner sets one (a `snappfood` sale with no rate configured still
  posts fine — the full amount just goes to `platformReceivable` with no commission split). A new
  "پلتفرم‌های سفارش آنلاین" settings tab (`online-platforms-settings.tsx`, `/api/settings/online-platforms`)
  edits it, following the same small-percent-field pattern as the existing tax/pricing settings tabs.
- **`/api/orders/[id]/pay`** accepts `method: "snappfood"`, resolves the configured commission % to a
  Rial amount, and passes it through to posting — the ledger layer never has to know about %s or
  settings, same separation of concerns tip capture already established.
- **Checkout UI** — "اسنپ‌فود" added as a payment-method button alongside cash/card/(credit) in both
  `order-detail.tsx` and `pos-screen.tsx` (desktop + mobile panels, which gained their first
  third-payment-method column since they previously only offered cash/card).
- Verified in a new `describe` block in `integration/order-payment-channel-revenue.integration.test.ts`:
  no commission configured still posts (full amount to `platformReceivable`); a commission splits the
  debit correctly; a balanced entry with commission + tip together; a non-`snappfood` method rejects a
  non-zero commission; a missing `platformReceivable` account fails with the standard
  `MissingLedgerAccountError` → `409` treatment; and — caught only by manually testing the real
  checkout flow, since none of the ledger-level tests above ever touch the `payments` table itself —
  a direct test that `'snappfood'` is actually accepted by the `payment_method` enum column
  `/api/orders/[id]/pay` writes to (the first version of this migration added the well-known account
  and the ledger-service handling but forgot the enum itself; `ALTER TYPE payment_method ADD VALUE`
  fixed it, and this new test exists specifically so a future payment-method addition can't repeat
  the same gap silently). Also manually verified end-to-end in a live running instance: configured a
  20% SnapFood commission in settings, checked out an 850,000 Rial order via the SnapFood button, and
  confirmed the posted entry — debit `platformReceivable` 680,000 + `platformCommissionExpense`
  170,000, credit `فروش بیرون‌بر` (takeaway revenue) 850,000 — balanced and exactly matching the
  configured rate. `npx tsc --noEmit`, `npm test` (1025 tests, up from 1024 — one new
  `settings-tabs.test.ts` assertion updated, not a net-new test file), `npm run db:migrate` (twice,
  second run a no-op) + `npm run test:db` (348 tests, up from 342, on a clean database), and
  `npm run build` all pass.

**Wave 11 — account change-history / audit-trail (§7.5) — implemented.** The business owner answered
Wave 7's open question directly: yes, build it. `accounts` itself stays current-state-only, though —
no new history table. Every audited entity in this codebase (branches, employees, devices, shifts)
already logs to the same shared `audit_log` table (Phase 0/20) rather than getting its own dedicated
history table, and an account's rename/reparent/archive trail fits that exact shape (who, when, what
changed), so it reuses that infrastructure instead of adding a parallel one.

What shipped:

- **`accounts-service.ts`** — `renameAccount`/`reparentAccount`/`setAccountActive` each now take an
  optional `actorId` and write an `audit_log` row (`entity: "account"`) on an actual change: `before`/
  `after` name for a rename, `beforeParentId`/`afterParentId` for a reparent, and a distinct
  `account.archived`/`account.reactivated` action for the active flag — mirroring
  `branch-service.ts`'s existing "write inside the mutating function, not the route" placement. A
  no-op call (renaming to the same name, reparenting to the same parent) writes nothing — there's no
  real change to log. The one call site (`/api/ledger/accounts/[id]` PATCH) now threads
  `session.sub` through.
- **`audit-service.ts`'s `listAuditLog`** gained an `entityId` filter (one entity's own history, not
  just its type) and two new live-resolved joins: `entityName` now also covers `entity = 'account'`
  rows (current code — name, even if renamed again since), and `accountBeforeParentLabel`/
  `accountAfterParentLabel` resolve a reparent's before/after parent the same live way
  `credentialType`/`deviceLabel` already resolve for other entities — never duplicated at write time,
  so a parent account renamed after the fact still displays correctly.
- **`audit.ts`** gained Persian labels for the four new actions and the `account` entity.
- **A new `accounts.edit`-gated `GET /api/ledger/accounts/[id]/history`** and `AccountHistoryPanel`
  (`account-history-panel.tsx`), reached via a "تاریخچه" button next to the existing "گردش حساب"
  (account statement) button on the chart-of-accounts tab — same per-account modal pattern as
  `AccountStatementPanel`, but reading the audit trail instead of the ledger. Gated on `accounts.edit`
  specifically (not `team.manage`, which the *general* security audit-log settings tab uses) so an
  accountant role that can edit the chart but has no HR-flavored `team.manage` permission still sees
  it; the general audit-log settings tab also gained "حساب" as an entity filter, for whoever does have
  `team.manage`.
- Verified in `src/lib/audit.test.ts` (the four new action labels, the `account` entity label) and a
  new `describe` block in `integration/chart-of-accounts.integration.test.ts` (7 tests: a rename
  records its before/after name; a same-name rename records nothing; a reparent resolves both
  before/after parent labels live; reparenting to no parent records a null after-label, not a missing
  one; a same-parent reparent records nothing; archive and reactivate land as two distinct, ordered
  actions; a later rename doesn't retroactively change an earlier archive entry's resolved account
  label). Also manually verified end-to-end in a live running instance: archived an account from the
  chart-of-accounts tab, opened its "تاریخچه" panel, and confirmed the rendered entry — action
  «بایگانی حساب», actor «مالک نمونه», a correctly Jalali-formatted timestamp. `npx tsc --noEmit`,
  `npm test` (1028 tests, up from 1025 — the repo's mechanized API-guard sweep in
  `api-guards.test.ts` auto-discovered the new route and needed one line added to its
  permission-guarded allowlist, same shape as the existing `ledger/accounts/[id]` entry),
  `npm run db:migrate` (twice, second run a no-op — this wave added no migration, reusing
  `audit_log`), `npm run test:db` (355 tests, up from 348), and `npm run build` all pass.

**Epic #160 status: everything in the original gap analysis is now either shipped or explicitly
deferred to a real product decision.** What's left, not built here:

- **Wave 6 in the gap analysis's revised sequencing (§8) was never meant to be built here** — it's
  Phase 21's own remaining Waves 5-7 (watch, accessories, specialized industry reports), tracked under
  `docs/phases/Phase-21-Multi-Industry-Accounting-Platform.md`, not duplicated under this epic. See §5/
  §6 of this document for the original reasoning.

That's a deliberate scope boundary, not unfinished work — consistent with how every other phase in
this codebase (7, 16, 21) resolved its own genuinely open questions before building against them,
rather than guessing.
