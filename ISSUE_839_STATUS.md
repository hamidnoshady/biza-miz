# Issue #839 — final status report

This is the status block prepared for **hamidnoshady/biza-miz#839**. The Arena
GitHub App in this session can open issues and merge pull requests but cannot
edit an issue body or post a comment (`Resource not accessible by integration`,
HTTP 403), so it is recorded here instead: paste everything below the line into
the issue, or reconnect GitHub with issue-write scope and it can be applied
directly.

Kept in the repository (rather than only in the session) so the evidence trail
survives with the code it describes.

---

# Status — 2026-10-15 (maintainer note)

Waves 1–6 are implemented and merged. Every acceptance criterion in this issue is met on `main`; the issue is **left OPEN for exactly one reason** — the production rollout of the merged commit cannot be verified from CI (see *Remaining blocker*). Nothing in the specification is outstanding.

## What shipped

**PR #858** — the automotive module (merged 2026-10-13, merge commit `376b618`).

- `automotive` registered as a canonical industry (`src/lib/industries.ts`, `INDUSTRY_LABELS` «خودرو و نمایشگاه اتومبیل», `ENABLED_INDUSTRIES`), industry profile and module gating, setup wizard, superadmin/provisioning, business-type change flow, pairing snapshot.
- Vehicle identity on the serialized unit: `items` = make/model catalogue, `item_serials` = the physical car, `automotive_vehicle_attributes` = one-to-one vehicle metadata, with partial unique indexes over `upper(vin)`, `upper(chassis_number)`, `upper(engine_number)` and `upper(stock_number)` (migration 0212).
- Lifecycle (`draft → in_stock/reserved → sold/archived`, plus `transferred`/`acquired`/`returned`), acquisition (`dealer_purchase`, `opening_stock`, …), landed costs with the capitalized-vs-period decision (0212), append-only price history (0212), reservations with deposits booked as a liability and released/refunded explicitly (0212, 0215), sales with frozen effective cost → revenue/COGS/tax postings and reversals (`automotive_vehicle_sales`, 0215), branch transfers with an open-transfer unique index (0212), Media Library links (0216), CRM lead preferences + vehicle links (0213), automotive reports (0214), permissions `vehicles.*` (13 keys, cost and minimum price separated from plain view), workspace UI and dashboard.
- Migrations: `0211`–`0216`.

**PR #961** — #839 Phase 2 (§19 offline/hybrid) and Phase 3 (backup/restore) (merged 2026-07-15 → 2026-10-15, merge commit `4aeeac1`; branch commits `4459fe8` + `c275e63`).

- Migrations: `0222_automotive_offline_hybrid.sql`, `0223_automotive_offline_request_acknowledged.sql`.

## §19 — offline/hybrid, and why it is safe

The governing rule: **a mirrored vehicle row is read-only, and the only offline write is a queued hold request that the cloud confirms before it becomes a reservation.** There is no generic last-write-wins anywhere on sales, reservations, transfers or accounting.

| Concern | Answer |
| --- | --- |
| Cloud mode | Unchanged — the cloud is the only side that sells, transfers or posts. |
| Hybrid/desktop reads | `automotive_vehicle_stock_mirror` (`0222`) holds one row per car of **that branch**, replaced whole by the snapshot served by `GET /api/server-sync/automotive-stock` (site credential, `snapshot` bootstrap, `locationScope "site"`). |
| Read-only vs writable | The mirror payload deliberately contains **no** acquisition cost, capitalized cost, minimum price or sale document — a showroom laptop cannot leak a margin, and no offline path can invent a ledger effect from mirrored data. Offline-writable work is the separate queue, shown as «pending cloud confirmation» until the cloud answers. |
| Idempotency | Requests carry a client-generated id and are written `INSERT … ON CONFLICT DO NOTHING` + one sync outbox event (`clientEventId = requestId`), so a repeated click, a retried POST and a replayed event collapse into one request. Snapshots compare content hashes (`mirrorRowHash`, `vehicleMirrorRowHash`, `planMirrorReconcile`): re-applying an identical snapshot writes nothing (`inserted: 0, updated: 0, removed: 0`). |
| Version checks | Every request carries `expectedVersion`/`expectedState`; mirror rows carry `sourceVersion`; `planRequestStatusApply` is monotonic, so a stale `pending` snapshot never revives a resolved request. |
| Transaction boundaries | One transaction per queued request on the site; on the cloud `applyVehicleOfflineRequest` locks the vehicle `FOR UPDATE`, re-checks the reservation rules and wraps the work in `SAVEPOINT automotive_request_apply`. |
| Conflict handling | A car another branch already holds returns `conflict` / `vehicle_reserved_by_other`; the one-active-hold-per-serial partial unique index turns the race into `23505` instead of a second reservation. Conflicts offer retry / cancel / open-vehicle, and «خواندم و بستم» records an acknowledgement (`0223`: `acknowledged_at`/`acknowledged_by`, CHECK-restricted to conflicts) that clears the «نیازمند تصمیم» count while keeping the refusal in history. |
| Never a fake sale | Nothing offline posts. A deposit posts exactly once, on the cloud, through the existing automotive posting rules; the integration test asserts exactly one `automotive_reservation_deposit` entry and zero on the site before confirmation. An unconfirmed request is never presented as a completed sale or reservation. |
| Duplicate identity | The mirror enforces partial unique indexes over `upper(vin)`, `upper(chassis_number)` and `upper(stock_number)`; a payload that names the same car twice is refused whole. |
| Pairing/replication | `automotive_vehicle_board` is declared `cloud_authoritative` + `snapshot` bootstrap + `defer` for cloud/hybrid/site in `replication-catalogue.ts` and mirrored in `data-ownership.ts`; the 8 cloud-only automotive tables stay cloud-only (the mirror and the request queue are the only site tables). Pairing discloses the read-only mirror to the operator while vehicle records stay in `centralOnlyData`. |
| Terminal vs retryable | A malformed queued payload is dead-lettered with a legible code (`c275e63`), never retried forever; the answers that can change come back as outcomes, not errors. |

## Acceptance criteria

- [x] `automotive` is selectable as a business type in tenant and superadmin creation flows — industry registry + provisioning/validation + platform picker; `integration/business-industry`, `integration/industry-family`, `automotive` suite.
- [x] Persian UI identifies it as «خودرو و نمایشگاه اتومبیل» — `INDUSTRY_LABELS`.
- [x] Automotive businesses never receive restaurant-only navigation or APIs — industry profile grants the core modules and withholds F&B modules; `industry-profile`/`feature-scope`/`feature-gating` tests.
- [x] New and used cars are explicitly distinguishable — `automotive_vehicle_attributes.condition` + per-vehicle mileage/prior-owner validation.
- [x] Every physical vehicle is tracked by VIN/chassis/stock identity — `automotive_vehicle_attributes` on one `item_serials` row, with normalized identity (`normalizeVin`, `normalizeChassis`, `normalizeStockNumber`).
- [x] Duplicate VIN/chassis cannot create ambiguous stock — partial unique indexes (`uq_automotive_vehicle_vin`/`_chassis`/`_engine`/`_stock_number`); the same indexes are asserted again *on the restored database* in `integration/automotive-backup-restore.integration.test.ts`.
- [x] Acquisition cost, attached costs, effective cost, asking price and sale price stay separate and auditable — `purchase_cost_rial`, `automotive_vehicle_costs` (capitalized vs period, void-not-edit), `unit_cost`, price history, frozen `frozen_effective_cost_rial` on the sale.
- [x] A vehicle is in one valid lifecycle state and location at a time — state machine + `lockVehicleAtBranch` + per-branch location binding; transfers use a single open-transfer unique index.
- [x] Reservation prevents accidental duplicate sale/reservation — one active hold per serial (partial unique index), `reserveVehicle` re-checks state and customer, and the offline path turns the race into a conflict.
- [x] A completed sale marks the exact vehicle sold and posts correct revenue/COGS/tax — `automotive_vehicle_sales` + posting rules; reversals unwind through the existing ledger.
- [x] Vehicle margin and stock-age reporting are available — automotive reports (stock/valuation, sales/profitability) plus the mirror's ageing on the desktop board.
- [x] Existing CRM, Media, Accounting, Reports, AI, roles, audit, pairing, backup and offline architecture reused — CRM lead tables, `media_assets` links, `journal_entries`, report registry, permission registry, `tenant-export.ts` (no second engine).
- [x] All new tenant data is protected by RLS and tenant-isolation tests — every new table `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy; asserted per table, including both §19 tables (third business sees 0 rows).
- [x] Existing business types remain behaviorally unchanged — the module is additive; the industry profile only grants automotive modules.
- [x] No dead/duplicate automotive-specific paths — one accounting, one inventory, one CRM, one media library, one sync engine.

## Verification (merged commit `4aeeac1`)

- **CI `test` run [38730077529](https://github.com/hamidnoshady/biza-miz/actions/runs/38730077529)** — every job success: type check, ESLint, unit tests, production build, API guard/permission tests, **integration tests against a real PostgreSQL** (32 min, the whole `test:db` suite), data-transfer engine, design checks, media E2E, **visual regression**, “all checks passed”.
- **PR #961 runs** — `test` [38720640511](https://github.com/hamidnoshady/biza-miz/actions/runs/38720640511) / [38720645941](https://github.com/hamidnoshady/biza-miz/actions/runs/38720645941) success; `verify-shippables` [38720640609](https://github.com/hamidnoshady/biza-miz/actions/runs/38720640609) success (desktop shell, production container, packaged Windows end-to-end 16m40s); `build-desktop-installer` [38720640559](https://github.com/hamidnoshady/biza-miz/actions/runs/38720640559) success.
- **Migrations** — `0222`/`0223` apply on a fresh database (twice, in the backup/restore test's two scratch databases) and re-applying is a no-op on an up-to-date database.
- **Targeted suites** — automotive 45/45, offline/hybrid 2/2, backup/restore 2/2, sync classification 4/4, export/restore/tenant-isolation 15/15, sync-events 28/28, cheques 101 + 2 = 103/103.
- **Visual regression note (Wave 6)** — PR #858's run [38391146936](https://github.com/hamidnoshady/biza-miz/actions/runs/38391146936) failed `accounting-cheques` 0.65% and `accounting-cheques-dark` 0.52% against the then-flat 0.5% ceiling. Cause: text-edge rasterisation on the densest small-RTL-text screen, **not** a UI change — the two baseline blobs are byte-identical (`8db8a5f…`, `6c4b424…`) at the PR head, at its merge and on `main` today. Resolved on `main` by the documented per-screen ceiling `CHEQUE_REGISTER_MAX_DIFF_RATIO = 0.01` (owner decision 2026-10-13), with no baseline re-recorded; cheque functionality is untouched.

## Remaining blocker (why this issue is still open)

The production rollout of the merged commit cannot be verified from CI. The post-merge `publish` workflow fails at **“Trigger Coolify redeploy”** (`Invoke-RestMethod POST https://manage.eshobe.com/api/v1/services/jrfpvt0rctfkmzpw1ao5c1cb/restart?latest=true` with `COOLIFY_API_TOKEN`), and because `PRODUCTION_HEALTH_URL` is unset the workflow can only emit “Production rollout unverified”. The same step fails on every previous `main` push — runs `38727423122`, `38594951908`, `38586425912`, `38572646960`, `38570211613` — so it is environmental (production credentials/endpoint), not a defect in this work.

Everything a rollout needs is merged and green. The issue stays **OPEN** until a production redeploy is verified; per the closure rule, production access is a blocker rather than something to assume. Closing it is a one-liner once that verification exists.

## Follow-ups

- **#963** — two-sided trade-in (§9) as an optional second wave, with acceptance criteria. The data model already records the *intent* (CRM trade-in flags), and nothing in it precludes the linked sale+acquisition workflow.
