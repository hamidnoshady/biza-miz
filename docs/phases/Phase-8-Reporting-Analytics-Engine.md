# Phase 8 — Reporting & Analytics Engine

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–7
**Goal:** Users can build custom reports from stored data and pin them to a dashboard, alongside a library of standard pre-built reports.

---

## Scope

- Reporting views (Postgres `VIEW`s): `v_sales_by_day`, `v_inventory_valuation`, `v_ledger_by_account`, `v_menu_item_performance`, `v_shift_reconciliation`, `v_table_turnover`, `v_staff_performance`, `v_waste_summary`
- Report builder UI: data source → metric (sum/count/avg) → dimension (day/week/item/category/location/staff) → filters (date range, location)
- `SavedReports` persistence
- Dashboard: resizable widget grid (`react-grid-layout`), chart type per widget (line/bar/pie/number card), per-user/per-role arrangement
- Pre-built standard reports shipped by default: daily sales summary, shift reconciliation, COGS trend, inventory valuation, top-selling items, waste report, P&L, Balance Sheet, staff performance, table turnover time
- Export: Excel/CSV/PDF on every report and dashboard

## Out of scope

- Nothing further planned beyond this — Phase 9 is rollup/polish, Phase 10 is post-v1 delivery

## Exit criteria

- All pre-built standard reports render correctly against real seeded data, including P&L and Balance Sheet that trace back correctly to the Phase 7 ledger
- A user can build a new custom report from scratch (source + metric + dimension + filter) with no code, and pin it as a dashboard widget
- Export to Excel/CSV/PDF works correctly on at least one standard and one custom report
- Custom reports only ever query views, never raw transactional tables directly

---

## Questions to answer before/during this phase

1. **Report access by role** — should Cashiers/Waiters see any reports at all, or is this entirely a Manager/Owner feature?
2. **Dashboard defaults** — what should the Owner's dashboard show by default on first login after this phase ships (which 3-4 widgets matter most to you day-to-day)?
3. **Comparison periods** — do you want built-in period-over-period comparison (e.g. this week vs. last week) on standard reports, or is that a custom-report-only capability?
4. **PDF report branding** — should exported PDF reports carry your business logo/letterhead, matching the receipt branding from Phase 5?
5. **Real-time vs. scheduled** — do dashboards need to update live during service (e.g. today's sales ticking up in real time), or is periodic refresh (every few minutes) acceptable?
6. **Alerting** — beyond low-stock alerts (Phase 6), do you want threshold-based alerts on any financial metrics (e.g. "notify me if daily sales drop below X")?

---

## Decisions on Phase 8 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Report access by role** — Owner/Manager only, matching every other back-office/financial surface (`/dashboard/ledger`, `/accounting/inventory`'s admin tabs — see Phase 6/7 decisions). Every `/api/reports/*` and the report-editing half of `/api/dashboard/widgets` (POST) is role-gated to `owner`/`manager`; the dashboard *page* itself stays open to every role (it already was, since Phase 0), but a Cashier/Waiter/Kitchen user only ever sees whatever an Owner/Manager has pinned to their role's default layout — there's no self-service report access for those roles in v1.
2. **Dashboard defaults** — seeded once, lazily, the first time the Owner's role-default layout is requested and none exists yet (`seedOwnerDashboardDefaults`, `src/lib/reports-service.ts`): daily sales trend (bar), shift/cash reconciliation (bar), top-selling items (pie), and staff performance (bar) — a 2×2 grid covering revenue, cash accountability, what's moving, and who's selling it, without opening a single report. The Owner can rearrange, remove, or replace any of these afterward exactly like a personal layout (it *is* a personal-shaped layout, just scoped to the role instead of one user).
3. **Comparison periods** — not built into standard reports for v1. Every report (standard or custom) already accepts a date-range filter, so a period-over-period comparison is one custom report per period today (run "this week," change the dates, run "last week"), not a first-class side-by-side widget. A dedicated comparison mode would need a second date-range dimension threaded through `buildReportQuery`'s SQL shape; deferred rather than half-built.
4. **PDF report branding** — business name + location address/phone in the PDF header (`report-pdf-template.ts`'s `pageHeader`), matching exactly what the receipt template already shows (Phase 5) — no logo, because no logo field exists anywhere in the system yet (receipts don't carry one either). Adding logo upload is new, unrelated scope, not a one-line extension of this phase.
5. **Real-time vs. scheduled** — periodic (on-demand fetch, no live push). Every widget/report re-queries when its page loads; nothing subscribes to `src/lib/realtime.ts`'s WebSocket broadcast channel (which Phase 4 built for kitchen/waiter order state, not aggregate reporting). Wiring live sales ticking would mean broadcasting on every payment and having the dashboard re-run its aggregate query on each event — real, but a materially bigger feature than "add reports," left for a later pass if it turns out to matter in practice.
6. **Alerting** — out of scope. Phase 6's low-stock alert stays the only threshold alert in the system; no new alerting infrastructure (delivery channel, threshold config UI, evaluation schedule) was built here. A "sales dropped below X" alert would need all of that from scratch, not just a query against the new views.

**Other decisions made while building:**

- **No shift/till entity exists, so "shift" is a proxy** — Phases 0–7 never built a till-open/till-close or clock-in/clock-out concept. `v_shift_reconciliation` (`migrations/0008_reporting.sql`) defines a "shift" as the set of orders one cashier closed on one business day — the finest granularity actually trackable today — reconciled by payment method (cash/card/online/credit). A real shift entity (with a float, an open/close time narrower than a calendar day) is Phase 9/10 territory; this view will need a real `shift_id` join if that ever lands, but the report itself doesn't change shape.
- **Business-day bucketing uses the location's timezone, not UTC** — every day/week/month-bucketed view truncates `(timestamp AT TIME ZONE l.timezone)::date` (using `locations.timezone`, stored since Phase 0) rather than the raw UTC date, so a sale at 11pm Tehran time lands on the correct business day even though it's already past midnight UTC.
- **Views are the only thing a report ever queries — enforced by construction, not convention** — `src/lib/reports.ts`'s `REPORT_VIEWS` is a fixed whitelist of view names, columns, dimensions, metrics, and filters; `buildReportQuery` resolves every part of a `ReportConfig` against that whitelist before touching SQL, and rejects anything that doesn't match (`validateReportConfig`). A report config only ever supplies *keys* (e.g. `"dimension": "day"`), never raw SQL or column names, so there's no path from a report config to a raw transactional table, or to SQL injection — this is what `reports.test.ts` asserts directly.
- **Custom-report shape: one metric, one dimension, one aggregation, plus filters** — matches the phase's own framing ("data source → metric → dimension → filters"). Metrics are `sum`/`avg`/`count` over a whitelisted numeric column (or row count); dimensions are either a date bucket (day/week/month, truncating the view's date column) or an entity grouping (item, category, staff, table, account, …); filters are a date range plus, where a view declares one, an equality filter (e.g. ledger reports can filter to one `account_code`). "Location" isn't a filterable/groupable dimension yet, since v1 is single-location per business (same rule Phase 7 followed for the ledger) — nothing to slice by until Phase 9.
- **P&L and Balance Sheet aren't generic report configs** — they're structured account-type rollups (revenue/expense sections for P&L; asset/liability/equity for Balance Sheet), which doesn't fit the single-metric/single-dimension shape every other report uses. `getProfitAndLoss`/`getBalanceSheet` (`src/lib/reports-service.ts`) compute them directly from `v_ledger_by_account` — still a view, never a raw table — with dedicated PDF/table rendering (`renderReportLedgerHtml`, `ledger-report-view.tsx`). The Balance Sheet folds a computed "retained earnings (current)" line into equity (all-time net income up to the as-of date) since this system never posts a period-closing entry — without that line, assets would never equal liabilities + equity. It balances by construction: every journal entry is balanced at posting time (Phase 7), so trial balance across all accounts sums to zero, which is exactly the identity Assets − (Liabilities + Equity + (Revenue − Expenses)) = 0.
- **Inventory valuation prices FIFO lots when they exist, else weighted-average** — `v_inventory_valuation` sums remaining `inventory_lots` value per item when any exist (the locked costing method is `fifo` — Phase 6), otherwise falls back to `stock_qty * avg_cost` (weighted-average). A view can't cheaply know which costing method is locked without joining `settings`, so it infers it from which pricing data actually exists per item — correct either way since `inventory_lots` is only ever populated under FIFO.
- **Standard reports are chartable; custom reports are chartable the same way** — every standard report except P&L/Balance Sheet ships a `defaultChart` (`STANDARD_REPORTS`, `src/lib/reports.ts`): a `ReportConfig` plus a suggested chart type. The UI runs that config through the exact same `/api/reports/query` path a custom report uses, so "standard" vs. "custom" is only a difference in who authored the config, not in how it's executed, exported, or pinned.
- **Standard reports are materialized as `saved_reports` rows, not hardcoded widget sources** — `dashboard_widgets.saved_report_id` is a real foreign key, so a widget (standard or custom) always points at an actual saved report. `ensureStandardSavedReports` idempotently upserts one `saved_reports` row per standard report with a chart (keyed by the new `standard_key` column, `business_id + standard_key` unique), the first time a business's reports are listed or its dashboard defaults are seeded — this is also how "pin to dashboard" works uniformly for both standard and custom reports.
- **Chart rendering is hand-rolled SVG, not a charting library** — matches the project's existing pattern of hand-rolling rather than adding a dependency for something narrow (`src/lib/jalali.ts`, `src/lib/escpos.ts`). `src/app/dashboard/charts.tsx` implements horizontal bars (reads better than vertical columns for RTL and long item/staff-name labels, no axis rotation needed), a line chart with a direct end-label, a donut with an always-present legend, and a number/stat tile — using the dataviz skill's validated 8-hue categorical palette (`globals.css --chart-1..8`, fixed order, swapped in for the previous grayscale shadcn placeholder) and its mark specs (thin lines, rounded bar ends, a legend whenever ≥2 series are shown).
- **`react-grid-layout` needs an explicit LTR island** — the library positions widgets with `transform: translate(Xpx, Ypx)` and no explicit `left`/`right`. Under this app's `dir="rtl"` (set on `<html>` since Phase 0), a browser's fallback "static position" for an absolutely-positioned box with both offsets `auto` anchors from the *right* edge instead of the left, so every `translate()` landed in the wrong place (verified by rendering the dashboard and inspecting computed layout — two of three widgets rendered off-screen, past the viewport's right edge). Fixed by wrapping just the grid container in `dir="ltr"` (`dashboard-grid.tsx`) and re-declaring `dir="rtl"` on each widget's own content so Persian text still reads correctly — the same "isolate the geometry, keep the content RTL" approach the codebase already uses for phone numbers and dates.
- **PDF rendering reuses the Phase 5 screenshotting technique, not a new dependency** — no PDF library existed in the project; `playwright-core` already did (Phase 5, for receipt/kitchen-ticket rastering, because ESC/POS printers can't shape Persian text themselves). `src/lib/pdf-render.ts` mirrors what the receipt renderer did almost exactly (launch Chromium, embed the Vazirmatn font as a data URI, render to a buffer) and runs inside this app's own Next.js server (today's receipt raster lives in `src/lib/printing/chromium.ts`), so it resolves the font path from `process.cwd()` instead of `__dirname` (reliable once Next bundles the route handler; `__dirname` inside a bundled handler isn't).
- **Export filenames are RFC 5987-encoded** — a `Content-Disposition: attachment; filename="…"` header value must be an ASCII ByteString; a Persian report title crashed the response until the route (`/api/reports/export`) switched to `filename="report.<ext>"` (ASCII fallback) plus `filename*=UTF-8''<percent-encoded-Persian-title>` (what modern browsers actually use).
- **Date values in exports/dashboards are Jalali, not raw ISO** — a date-bucketed dimension comes back from Postgres as a JS `Date`; both the CSV/Excel export (`report-export.ts`) and the client-side widget/report UI (`report-ui.ts`'s `formatDim`) convert it to a Jalali string with Persian digits before it's ever shown, matching the project-wide "Jalali is display-only" rule (`src/lib/jalali.ts`).

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| All 8 standard reports (excl. P&L/Balance Sheet) render correctly against real seeded data | `runStandardReportRows`/`runCustomReportQuery` (`src/lib/reports-service.ts`) via `GET /api/reports/standard/[key]` and `POST /api/reports/query`; verified end-to-end against seeded fixture data (orders, payments, purchases, waste, a closed table session) in `/accounting/reports` → «گزارش‌های آماده» |
| P&L and Balance Sheet trace back correctly to the Phase 7 ledger | `getProfitAndLoss`/`getBalanceSheet` (`src/lib/reports-service.ts`), built directly on `v_ledger_by_account`; verified against fixture ledger entries that the Balance Sheet's `balanced` flag is `true` and assets/liabilities+equity match exactly |
| A user can build a new custom report (source + metric + dimension + filter), no code | `/accounting/reports` → «گزارش‌ساز» (`report-builder-section.tsx`), backed by `GET /api/reports/views` (the whitelist) and `POST /api/reports/query` |
| A custom report can be pinned as a dashboard widget | «سنجاق به داشبورد» (`pin-button.tsx`) → `POST /api/dashboard/widgets`; renders on `/dashboard` (`dashboard-grid.tsx`, `react-grid-layout`) with per-user personal layout, falling back to a per-role default (`getDashboardWidgets`) |
| Export to Excel/CSV/PDF works on at least one standard and one custom report | `POST /api/reports/export` (`src/app/api/reports/export/route.ts`), backed by `rowsToCsv`/`rowsToXlsxBuffer` (`report-export.ts`) and `renderHtmlToPdf` (`pdf-render.ts`); exercised on both a standard report (daily sales) and a custom builder report during manual verification, plus P&L/Balance Sheet's dedicated ledger export path |
| Custom reports only ever query views, never raw transactional tables | `REPORT_VIEWS` whitelist + `buildReportQuery`'s validate-then-resolve design (`src/lib/reports.ts`, unit-tested in `reports.test.ts`) — a report config supplies keys, never SQL or table/column names |

Dashboard UI: `/dashboard` (`src/app/dashboard/page.tsx` + `dashboard-grid.tsx`) — resizable/draggable widget grid, edit-mode toggle, per-widget remove, Owner/Manager only for editing. Reports UI: `/accounting/reports` (`reports-manager.tsx`) — «گزارش‌های آماده» (standard report library, incl. P&L/Balance Sheet) and «گزارش‌ساز» (custom report builder + saved custom reports list).

---

## Corrections from issue #819 (reporting audit)

The audit found several places where this phase's stated behaviour and the
implementation had drifted apart. The corrections below supersede the
decisions above where they overlap; the code is the source of truth.

- **Report access is capability-derived, not role-derived.** Decision 1's
  "Owner/Manager only, every `/api/reports/*` is role-gated" no longer
  describes the system. What a member may do is computed from their *effective*
  permissions into one object (`reportCapabilities`, `src/lib/report-permissions.ts`):
  `canViewReports` / `canBuildReports` ← `reports.view`; `canManageSavedReports`
  ← `reports.manage`; `canExportReports` ← `reports.export`;
  `canViewBusinessWide` ← `reports.business_wide` (owner-only, in the
  cross-location trust family with `rollup.manage`); `canManageRoleWidgets` ←
  `reports.dashboard_defaults.manage`. The server page passes that object to the
  client, and both the sidebar children and the in-page rail are gated by the
  same keys (`reports-nav.ts`) — no report surface reads a role name any more.
- **`reports.view` runs reports; `reports.export` produces files.** The query
  endpoint used to require `reports.export`, so a member could not read a report
  without also being able to walk out with every file the product can produce.
  Saving, renaming and deleting a saved report is `reports.manage` — authoring,
  not reading and not downloading.
- **Consolidated (business-wide) reporting has its own authorization path.**
  `reports.business_wide` gates `GET /api/reports/business-overview`, the
  `business_overview` export kind, the role-default dashboard layout, and the AI
  `get_branch_comparison` tool. It is in `OWNER_ONLY_PERMISSIONS`, so no preset
  and no per-member grant confers it.
- **Branch isolation is the resolved active location, never the body.** Every
  report read and the `chart`/`shift_orders` exports inject
  `(await resolveActiveLocation(session))?.id` into the same query the screen
  used; a `locationId` in a request body is ignored. The standard-report route
  scopes every key except the four ledger-wide statements (P&L, cash flow,
  balance sheet, food cost variance), which are business-wide by definition.
- **`?tab=` is validated against the member's allowed tabs**, not against the
  tab catalogue, and the APIs stay authoritative regardless.
- **The builder round-trips the whole `ReportConfig`.** Every engine filter
  published by `/api/reports/views` is offered, and sort / Top-N / the chosen
  visualization are stored and restored (the pin button uses the stored chart
  instead of hardcoding `bar`). Money metrics marked `money` are formatted in
  the business's display unit. A preview superseded by a newer one is aborted
  and cannot overwrite it.
- **Screen == CSV == Excel == PDF.** Amounts are written in the business's
  display unit with the unit named on the column, and a reporting view's
  `date` column — which arrives as `YYYY-MM-DD` *text*, not a JS `Date` — is
  written in Shamsi, which is what "Date values in exports/dashboards are
  Jalali" always meant but did not cover.
- **The shift questions are answered separately.** Which orders belong to a
  shift is decided by `opened_at` (`shift-orders-service.ts`); which cash was
  settled is decided by `closed_at` (`v_shift_reconciliation`); the drawer count
  is `opening float + cash receipts − cash payouts`
  (`v_employee_shift_reconciliation.cash_variance`). The shift list states
  settled sales as its headline and keeps open/held/voided value beside it
  instead of summing every status into one «جمع».
- **Migration 0211 repaired two view defects** this document's line about
  split payments would otherwise contradict: `v_shift_reconciliation` summed
  `orders.total` across a `LEFT JOIN payments` (a split bill multiplied its
  gross by its payment count), and `v_employee_shift_reconciliation` attributed
  an order to a shift by employee and window alone, so an employee working a
  second branch could have those orders counted into the first branch's shift.
