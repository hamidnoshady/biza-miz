# Phase 1 — Setup Wizard

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0 (Foundation)
**Goal:** A fresh install can be fully configured end-to-end through a guided wizard, no manual DB edits.

> **Note:** this is the Phase-1 record. The wizard has since grown an optional Backup step and become
> industry-shaped (retail/service industries skip costing and menu); see the README's «First run — the
> Setup Wizard» section for the current flow. The 8-step list below describes the Phase-1 deliverable.

---

## Scope — 8 wizard steps

1. **Business info** — name, location(s), currency, language/calendar defaults
2. **Chart of accounts** — pre-built F&B template, or customize
3. **Inventory costing method** — FIFO vs Weighted Average, plain-language example of each, locked after first transaction
4. **Tax configuration** — rate(s) per menu category
5. **Roles & initial users** — create Owner (self), Manager, Cashier, Waiter, Kitchen accounts
6. **Menu import** — manual entry or CSV/Excel import
7. **Hardware pairing** — print agent setup, test print, cash drawer test
8. **Opening balances** — opening inventory count, opening ledger balances (books start accurate, not from zero)

## Out of scope (later phases)

- Actual order-taking (Phase 2)
- Table management (Phase 3)
- Real print agent implementation (Phase 5 — this phase just needs a pairing/test-print UI flow, can stub the actual ESC/POS driver)

## Exit criteria

- A brand-new business can go from empty DB to "ready to take orders" using only the wizard UI
- Costing method selection is saved and correctly locked/flagged as changed-only-via-formal-process
- CSV/Excel menu import correctly creates categories + items with prices
- Opening balances produce a valid, balanced initial journal entry (debits = credits)

---

## Questions to answer before/during this phase

1. **Chart of accounts** — do you want the standard pre-built F&B template Claude Code proposes, or do you already have a chart of accounts from an accountant you want matched exactly?
2. **Tax rules** — what's the actual VAT/tax rate(s) that apply to your business, and are any menu categories exempt (common for some food categories)?
3. **CSV/Excel import format** — do you have an existing menu spreadsheet to design the import format around, or should Claude Code define the template?
4. **Opening inventory** — will you do a real physical count to enter as opening balances, or start inventory tracking from zero going forward?
5. **Hardware pairing UX** — at this stage (before Phase 5 builds the real print agent), is a stub/placeholder "test print" screen acceptable, or do you want to defer step 7 entirely until Phase 5?
6. **Multiple locations at setup** — for now, are you setting up just one location through the wizard, with more added later via the same flow?

---

## Decisions on Phase 1 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Chart of accounts** — a pre-built F&B template is proposed (`src/lib/coa-template.ts`, 26 accounts, 4-digit codes: 1xxx assets … 5xxx expenses). The wizard shows it in an editable grid; you can add/remove/rename rows before creating it, or replace it wholesale. The chart is only replaceable while no journal lines reference it.
2. **Tax rules** — a single default VAT rate (percent, default 10) is stored business-wide and stamped onto new menu categories. Each category carries its own `tax_rate`, so exempt categories can be set to 0 after the menu exists. No hard-coded exemptions.
3. **CSV/Excel import format** — Claude Code defines the template: header row with «دسته / category», «نام / name», «قیمت / price» (Toman) required, «توضیحات / description» and «کد / sku» optional. Persian or English headers, Persian digits, and `, ; \t` delimiters are all accepted; a sample CSV is downloadable in-wizard. `.xlsx` is parsed server-side (first sheet).
4. **Opening inventory** — supported but optional. A physical count creates inventory items + an `adjustment` stock movement each, and that first inventory transaction locks the costing method. Businesses starting from zero simply skip the step.
5. **Hardware pairing UX** — kept in scope as a **stub**: printers are registered for real, but "test print" / "drawer kick" only log an audit event and return a receipt preview. The real ESC/POS driver arrives in Phase 5.
6. **Multiple locations at setup** — one location through the wizard (created at bootstrap). The schema already carries `location_id` everywhere; adding locations later reuses the same flow.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Empty DB → "ready to take orders" via wizard UI only | `/welcome` (bootstrap) → `/setup/*` (8 steps) → `/setup/finish` |
| Costing method saved and locked after first transaction | `src/app/api/setup/costing/route.ts`, `costingLocked()` in `src/lib/setup-state.ts`; locked on opening inventory |
| CSV/Excel import creates categories + items with prices | `src/app/api/setup/menu/import/route.ts`, `src/lib/menu-import.ts`, `src/lib/xlsx-import.ts` |
| Opening balances produce a balanced journal entry (debits = credits) | `src/app/api/setup/opening/route.ts`, `src/lib/opening.ts` (with auto-offset to «تراز افتتاحیه») |
