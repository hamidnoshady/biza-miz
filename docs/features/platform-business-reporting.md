# Superadmin business reporting (#810)

Entry: `/platform/businesses/{id}/reports`, registered once in the business
workspace's `sections.ts`. `business.reports.read` is a dedicated capability
for support, engineer and owner; it grants no tenant writes.

## Boundary

All APIs use `platformReportRoute`: platform-cookie authentication, live admin
capability check, UUID/business resolution, then `withTenant(validatedId)`.
Branch ownership is checked inside that scope before invoking any report.
POST `/query` is a read-only, strict-schema query, not arbitrary SQL; nested
business/location IDs, unknown fields, non-whitelisted sources, invalid
metric/dimension/aggregation/filter combinations and invalid dates are rejected.
The report catalog and custom sources are industry-filtered on the server.

Responses are `private, no-store`. Errors never forward provider exceptions.
CMS payloads are allowlisted and gift-card bearer codes are masked. No save,
seed, pin, export mutation, sync retry or publishing controls are mounted.
Statement drill-down buttons are disabled for this read-only presentation;
ordinary tenant reports retain their existing drill-down behavior.

## APIs and sources

Under `/api/platform/businesses/{id}/reports`:

- `GET /catalog`: tenant currency, branches, applicable catalog/view metadata,
  app availability and deployment-profile gates; does not execute reports.
- `GET /day`: authoritative selected-branch/business date for presets.
- `GET /overview`: existing branch sales overview, P&L and business activity,
  with independently failing panels. Does not execute the standard library.
- `GET /standard/{key}`: existing chart query or structured statement/trade
  dispatcher. `compare=1` uses existing comparison services/ranges. Balance
  Sheet accepts an explicit `previousAsOfDate`.
- `POST /query`: existing `runCustomReportQuery`, maximum 1,000 aggregate rows.
- `GET /branches`: existing business-wide branch overview.
- `GET /crm`, `/growth`: existing app overview services.
- `GET /websites`: local WP/Woo manager statistics.
- `GET /cms`: separately requested CMS managers/overview; CMS downtime cannot
  delay local WP, accounting or CRM. CMS preview limits are explicitly labelled,
  never represented as total site counts.
- `GET /health`: existing sync assessment, tenant backup health and device
  service, projecting status only (no credentials or raw provider errors).

Global `dateFrom`/`dateTo` are ISO business dates on the wire. UI dates are
Jalali. Currency is read from the selected tenant's `business.prefs`; all
amounts remain Rial in the API and pass through its `MoneyProvider` for display.

## Scope and performance semantics

CRM and Growth retain their **existing rolling-window contracts**; the UI
explicitly labels those windows rather than pretending that arbitrary date
filters were applied. CRM is business-wide; Growth's branch parameter affects
repurchase predictions only. Health, CMS and WP statistics are current,
business-wide snapshots. Branch comparison deliberately shows all branches.
Branch-only trade reports require a selected branch instead of fabricating an
all-branches result.

App panels and selected reports fetch lazily. Every hook aborts obsolete
requests and keys state by request/filter identity so late results cannot paint
under a new selection. Chart and table share one result set. Aggregated queries
are capped at 1,000 rows (or the catalog's smaller Top-N limit), with 50-row UI
pages. Structured detail collections have server response pages of 50 rows via
`?page=N`; statements retain their structure and authoritative full rollups.
Trade detail and food-cost variance now use **database-level paging** in the
existing authoritative services. A shared query helper computes full totals,
clamps the requested page, and applies a bound `LIMIT 50` / `OFFSET` in one
PostgreSQL snapshot. Only that page crosses into Node; no full detail array is
loaded just to slice an API response. Sorts include unique tie-breakers.
PostgreSQL still scans/aggregates the matching source for exact totals; this is
not a claim of constant database work for arbitrarily large histories.

Legacy full-list consumers retain their original API shapes through the same
SQL sources and mappers, with no limit when a page was not requested. Platform
reporting explicitly requests a SQL page. Accounting statement sections and the
fixed-purity reconciliation summary retain their structure rather than being
flattened or truncated.

The consignor report's former per-consignor detail reads were replaced by one
aggregate service query, checked against the existing detail statement. Signed
bar charts now have a zero baseline; pies with negative measures fall back to
signed bars rather than depicting losses as positive shares.

## Verification

`integration/platform-business-reporting.integration.test.ts` provisions an
unprivileged PostgreSQL role (neither superuser nor BYPASSRLS), and businesses
with 10 versus 100 completed orders. It exercises real route authentication,
A/B inverse isolation and service parity across sales, P&L, CRM, Growth,
WP/store statistics, branches and custom queries. CMS uses real tenant
connection lookup/decryption with only its remote HTTP client replaced. It
also probes a query with no business predicate from inside the scope, rejects
sibling locations, tenant tokens, unknown businesses, wrong-industry reports
and SQL-source injection.

Focused unit/UI tests cover capability-before-read ordering, strict request
validation, comparison dispatch, partial errors, lazy remote calls, response
paging without changing totals, stale-request cancellation, tenant money units,
Jalali dates, read-only statements and negative chart measures.

### Follow-up verification and diagnostics

Health uses `businessDesktopCompliance` from the existing desktop release
service. The shared reader runs its telemetry queries under the selected
business's RLS scope **and** binds its business predicate in SQL. It does not
invoke the fleet-wide bypass wrapper. Release selection, rollout/channel,
SemVer, schema compatibility and telemetry freshness use exactly the same
logic as the update console. The API projects installed/target/minimum versions,
compliance, connectivity and timestamps, never installer URLs, signed manifests,
update-event detail or raw errors. The UI is informational only; it cannot
install an update. WordPress also displays plugin/REST counts, taxonomy totals
and pending inbound events from the existing overview service.

The integration release gate now covers **all 146 industry/catalog
combinations across nine industries**, including structured comparisons.
Specialised empty shapes are compared as compatibility contracts, while
nonempty accounting/sales, tenant A/B telemetry, connector modes, taxonomy and
inbound counts, and large trade-detail fixtures exercise actual values. The
existing industry-service integration suite continues to check sale/repair/
consignment calculations against postings made by those services.

The scale check seeds **10,000 consignors with payout events** and **10,000
stocked items**, using the unprivileged application role for the report reads.
It asserts first/last page bounds, out-of-range clamping, preserved full totals,
a response budget of 32 KB, fewer than 40 queries per request and a generous
15-second first-page regression budget. Local measurements on 2026-10-05:

| Report | Queries/page | First-page JSON | First + last page, combined |
| --- | ---: | ---: | ---: |
| Consignor statements | 7 | 7,219 bytes | 198 ms |
| Dead stock | 7 | 8,281 bytes | 349 ms |

These are reproducible regression checks, **not production latency guarantees**.
They do not prove performance for arbitrary millions of rows. Following the
SQL-paging implementation, the test also checks the actual database result:
only 50 detail records are returned, with the limit bound as a parameter. The
full-source aggregate remains database work, not a Node-side rollup array.

### Browser checks

Use a local migrated database and a production build, with an unprivileged
runtime DB role and `DEPLOYMENT_ROLE=central` for the platform console. The
existing visual fixture must also run in the cloud profile; a local-only
process correctly renders capability gates instead of Growth/Websites pages.

- `npm run test:visual`: all **14 existing baselines match**, unchanged.
  The Playwright CDN was unavailable in this sandbox; the documented
  `VISUAL_CHROMIUM_PATH` fallback used `@sparticuz/chromium@141.0.0`, matching
  the baseline browser major. No browser dependencies were added to the app.
- `scripts/platform-report-smoke.mjs`: checks **1440px and 390px**, light/dark,
  across eight tabs (32 review screenshots). Verifies theme application, no
  document overflow, lazy initial fetching, branch selection, a structured
  comparison, SQL detail-page navigation and refresh, and absence of runtime errors, tenant API calls and
  write requests. Screenshots were visually reviewed, not auto-approved as new
  baselines. CMS remains deliberately unconfigured in this local fixture; its
  remote success/failure and tenant boundaries are covered by integration tests.

To reproduce the nonempty browser review:

```sh
# Owner connection to a LOCAL database only; idempotently creates a separate
# report fixture, without changing the ordinary visual-regression business.
DATABASE_URL=postgres://pos:pos@localhost:5432/pos \
  npx tsx scripts/seed-platform-report-fixture.ts
# Prints PLATFORM_REPORT_BUSINESS_ID. Create a local support operator using
# scripts/seed-platform-admin.ts, then set these variables in your shell:
# PLATFORM_REPORT_BUSINESS_ID, PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD
node scripts/platform-report-smoke.mjs
```

Set `VISUAL_BASE_URL` for another server and `VISUAL_CHROMIUM_PATH` only when
using the documented alternative browser. Review artifacts default to
`.cache/platform-report-smoke/`, ignored by Git. The fixture includes 65 stock
items, recorded sales and ledger revenue, customers, a campaign, a plugin
connection with taxonomy/inbound data, and a device with an available update.
Its dummy `.invalid` URLs and credentials are not usable integrations.

A catalog-bootstrap retry now actually refetches after an error; ordinary
report refresh keeps the chosen tab, branch and date filters instead of
unmounting the workspace. Both behaviors have UI regression tests.

Final local quality gate (2026-10-05): TypeScript and production build passed;
562 unit/UI files / 7,278 tests passed; 166 database files / 1,986 tests passed
and one existing skip; 38 design checks passed. On this 4 GB sandbox the build
ran alone with `RAYON_NUM_THREADS=1 NODE_OPTIONS=--max-old-space-size=2048`;
unconstrained compiler concurrency exhausted memory. The constrained repeat
build passed. All 14 visual baselines and all four browser smoke configurations
also passed after SQL paging, including navigation to the second detail page.


### SQL pagination completion

All ten unbounded structured detail shapes are SQL-paged: consignor statements,
layaway book, warranty register, repair profitability, variant sales, brand
sales, near-expiry batches, low stock, dead stock and food-cost variance.
`queryReportPage` receives only service-owned SQL and ordering expressions,
preserves the existing tenant context, and returns summary/empty-state metadata
without leaking its internal columns into report rows. Counting, clamping and
reading the page use one statement, avoiding count/page races within a request.
Different page requests remain live snapshots, not a pinned export session.

The real-database gate now builds 121-row and 73-row tenants with tied sort
values for **every** detail shape. Concatenating all pages must equal the legacy
full result; each page must preserve the full report's totals, including
out-of-range pages. SQL warranty states, repair rounding and layaway totals are
also checked against the independent pure contracts. Food-cost variance keeps
per-item rounding before summing the full theoretical cost.

Moving the dead-stock predicate to SQL exposed a date/timestamp mismatch in the
old JS filter: appending `T00:00:00Z` to an already complete `last_sold_at`
timestamp produced an invalid date. The pure classifier and SQL predicate now
share a UTC cutoff, tested at the exact boundary and one millisecond after it.
Previously sold, sufficiently old stock is no longer silently excluded.
