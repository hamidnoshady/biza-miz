# CRM engineering report

Branch `arena/01a0be29-cafe-restaurant-pos`, five commits on top of `37d92cd`.
71 files, +14,640 / −382.

Source of truth throughout was the code. Where a README or phase document
claimed a behaviour, the claim was checked against the implementation before
being believed, and several were wrong.

---

## 1. Verified bugs found and fixed

| Bug | Symptom | Fix |
|---|---|---|
| CRM overview segment count | `LIMIT 20` used as the total, so every segment over 20 people reported "20" | Counted with a `count(*)` query separate from the sample |
| Growth customers pinned row | Desktop and mobile disagreed about which customer was pinned | One derivation, shared by both renderers |
| `wpStoreCustomers()` | Pagination returned a total that was the page length | Total computed independently of the page |
| `mergeCustomers()` | Cross-app mappings (Woo, Holoo) not moved, silently orphaning them | Registry-driven move, see §4 |
| Website → CRM ownership | `upsertCustomerFromWoo()` wrote canonical `parties` directly | External-profile mirror + reconciliation, see §3 |
| `withTenant()` not a transaction | Multi-write invariants and `FOR UPDATE` guards were not atomic | `withTenantTransaction`, see §2 |
| RFM dirty flag | Never fired: a microsecond Postgres timestamp round-tripped through a millisecond JS `Date` never compared equal | Comparison moved into SQL |
| `ON CONFLICT` on a partial index | Custom field writes failed at runtime | Predicate repeated in the conflict target |
| Import phone matching | A bare `phone_e164 =` misses blind-indexed rows, so an import would create duplicates of existing customers | Routed through `phoneMatchSql` |

The last two were found by tests written in this pass, not by inspection.

## 2. Architectural changes

**`withTenantTransaction`.** `withTenant()` sets the tenant GUC on a pooled
connection but does not open a transaction, so a "transactional" service
function could interleave with another request and a `SELECT … FOR UPDATE`
locked nothing. Added `withTenantTransaction`, which pins a `PoolClient` under
BEGIN/COMMIT and routes `query()` to it through `AsyncLocalStorage`. Converted
`convertLead`, `mergeCustomers`, `savePipelineStages`, `moveDealToStage` and
`resolveExternalProfile`. A pinned client cannot run concurrent queries, so
`runOnPinnedClient` chains them rather than `Promise.all`.

**Layering.** UI → API route (validation, permission) → service (business
logic, transactions) → DB. No business logic was added to a React component.

**Migration 0157** adds 14 tenant-scoped tables, every one with `business_id`,
FKs, indexes, and RLS enabled + forced with a policy in the same migration. All
14 now have services behind them.

## 3. Cross-app boundaries

The CRM reads the other three apps through their services and owns none of
their data.

- **Accounting.** `ar-service.ts` exports the A/R attribution SQL;
  `crm-accounting-contract.ts` consumes it. The CRM contains no ledger joins of
  its own, so a customer's balance cannot differ between the CRM and the trial
  balance. `available: false` is distinct from zero.
- **Website.** Woo ingest no longer writes `parties`. It writes
  `crm_external_profiles` with provenance and a mapping status; an ambiguous
  match parks the profile for human review rather than guessing. No
  `ORDER BY created_at LIMIT 1` decides an identity anywhere. Ambiguity never
  suppresses customer creation — that regression broke online sales entering
  the customer file and was reverted.
- **Growth.** Send snapshots and campaign history stay in Growth; the CRM
  timeline maps them.
- **Deals never post revenue.** Winning a deal writes no journal line.
  `crm-deal-handoff.ts` links a deal to a sales document created by Accounting,
  idempotently, and audits `createdByCrm: false`.

## 4. Merge safety

Merge is irreversible, human-confirmed, behind its own `crm.merge` permission,
and absent from every AI and autopilot surface. References are moved from
`party-merge-references.ts`, a registry derived from FK metadata that
classifies each reference as move / historical / merge-blocking. The
hand-written list it replaced fell one table behind every feature that linked
something to a customer, and the symptom was silent.

Relationship edges are declared there too, with `selfEdgeColumn` and
`uniqueWithSql`, so self-edges and collisions are dropped before re-pointing.
A second copy of that logic was written in the relationship service during this
pass and deleted once the registry was found to already handle it.

## 5. Consent

Consent is never manufactured. Import has no consent column and ignores one if
present; lead conversion does not copy it; external identity resolution does
not touch it; export does not emit it. Each of those is asserted by a test, and
the boundary suite checks that consent writes exist only in the consent
service.

## 6. Features delivered

Leads with transactional conversion and dedupe (>1 candidate stops the
conversion); configurable pipelines with stage history and stable user ids;
case management with an SLA that subtracts time waiting on the customer and
reports `waitingOnCustomer` separately from `breached`; RFM freshness as a
scheduled job, never inside checkout; typed custom fields; a party relationship
graph; saved views; segment versioning; CSV import/export; granular permissions
(`crm.view/manage/merge/consent_manage/export/configure`) with owner and
manager presets preserved.

## 7. Tests

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm test` | 348 files, **5,022** passed (baseline 4,995) |
| `npm run test:db` | 119 files, **1,342** passed, 1 skipped (baseline 1,290) |
| `npm run test:design` | 36 passed |
| `npm run build` | compiled successfully |

All five ran to completion on this branch; the numbers above are from those
runs.

Added: `integration/crm-leads-pipeline` (19), `crm-scoring-freshness` (14),
`crm-case-sla` (12), `crm-import-export` (22), `crm-fields-relationships` (30),
plus unit suites `crm-case-sla` (10), `crm-csv` (21) and `crm-app-boundaries`
(12).

`crm-app-boundaries.test.ts` reads the CRM's own source and fails the build on
a boundary violation — no ledger SQL outside the Accounting contract, no second
customer table, no identity `ORDER BY created_at LIMIT 1`, merge absent from AI
surfaces, and (added last) no client component value-importing a service that
imports `./db`. Each rule was verified to fail on the regression it describes.

## 8. Known gaps

- **`crm-service.ts:1566–1745`** still hardcodes the pre-0157 six-string deal
  vocabulary. The new pipeline layer writes the legacy `stage` column through
  `legacyStageKey()` so the two agree, but this is a second source of truth and
  should be removed once no caller reads the old column.
- **Migration 0157 backfills only businesses that existed when it ran.**
  `defaultPipeline()` self-heals on read, which covers it, but a provisioning
  path that assumed seeded rows would be wrong.
- The remaining IA sections (Reports, Data Quality dashboards) have services
  and APIs but thinner UI than Customers, Leads, Deals and Cases.
- Visual regression baselines were not re-recorded; no baseline was changed.
