# Phase 44 — Hybrid sync completeness

**Status:** Implemented (migrations 0189, 0190).

A paired desktop (the Windows site server) and the central server were meant to converge.
In practice some data crossed and much did not, and the desktop retried failing work every
30 seconds forever. This phase fixes the transport, closes the coverage gaps, and makes the
link check itself.

## Why only some data synced

| Symptom | Cause | Fix |
|---|---|---|
| Cloud → desktop never moved | `/api/server-sync/pull` sent `sync_events.id` (bigint → string in node-postgres); the desktop validates the cursor with `Number.isSafeInteger` and dead-lettered every event, then refetched the same batch | numeric id on the wire; the desktop also accepts the numeric string an older central sends |
| Desktop → cloud stopped at one event | a remote `deferred` (missing prerequisite) held the push cursor, and nothing on the central retried deferred events | per-row delivery (`sync_events.pushed_at`, 0189), deferred counts as delivered, `runCentralSyncMaintenanceTick` retries on the central |
| Some events never pushed | an id high-water mark passes a row whose transaction commits after a higher id, and a locally-deferred row applied late | per-row `pushed_at`; the backfill re-sends rows applied late |
| A paid bill refused by the cloud | only order *creation* and *payment* crossed; items added at the till, voids, discounts, customer, table and kitchen status did not, so the cloud settled a different bill | `order.state.synced@1`: the whole open bill after every change, and once more inside the payment transaction |
| Amendments missing from cloud books | closed-order corrections were never sent | `order.amendment.posted@1`, replayed with the desktop's line ids |
| Cloud edits never reached the branch | the outbox recorded only on a site | the central records for a branch with an active paired desktop |
| Customers / menu edits never synced | "bootstrap_only": copied once at pairing (customers not even that) | continuous master-data feed, merged per field |
| Sales on the wrong day in the cloud | replays stamped `now()` as `closed_at`, `received_at`, `opened_at` and the journal date | replays carry the sale's own instant and the desktop's posting date |
| Desktop update status always failed | `runtime-status` / `update-check` answered 401 by middleware before the bearer check | added to the session-less bearer paths |

## Decisions

1. **Cloud writes for a hybrid branch are sent to the branch** (owner's choice over making the
   cloud read-only for that branch). The desktop stays the operational authority: a cloud event
   it cannot apply becomes a dead letter the owner sees, never a silent difference.
2. **Master data merges field by field** (owner's choice over whole-record last-write-wins).
   Each field is a last-writer-wins register keyed by a hybrid logical clock
   (`<ms>.<sequence>.<node>`, migration 0190); a phone changed in the cloud and an address
   changed at the desktop both survive. The merge (`master-sync-merge.ts`) is pure, commutative
   and idempotent.
3. **Capture is a trigger, not a service call.** `trg_sync_capture` on the twelve master tables
   records per-field clocks for every write path — the owner's form, an importer, the
   assistant, a bulk edit. Its arguments and `MASTER_SYNC_TABLES` are one contract, pinned by a
   unit test. Applying a peer's change sets `app.sync_replay`, so nothing echoes back.
4. **Derived values never merge**: `inventory_items.avg_cost` / `carrying_value_rial` (each
   side costs from its own movements), `dining_tables.status`, CRM scores, and ciphertext
   (the plaintext twin crosses and is re-encrypted under the receiver's key).
5. **An open order converges by state transfer.** It has posted nothing to the books yet, so
   replacing its contents is safe; a settled order is never touched by a state event. The
   sender's totals are carried verbatim — promotions and tax rates may differ between sides and
   the bill a guest paid is the sender's. A line the receiver holds but the sender does not
   (an offline phone's `order.create` replayed under other line ids) is voided, never deleted.
6. **Only a peer server's instant dates a replay.** A phone's offline flush cannot place a sale
   into a closed day — there is still no "record a past sale" path.
7. **Retail invoices stay out of hybrid sync.** Pairing never copies the retail catalogue
   (`items`, stock, serials) to a desktop, so a retail business is not a hybrid candidate yet.
   Website (CMS) and Holoo-imported sales are settled on the central server and stay there.

## Transport

- Pull reads `(txid, id)` under `txid < pg_snapshot_xmin(pg_current_snapshot())` — only rows
  whose writing transaction has finished — so a late commit can never land behind the cursor.
  The master feed uses the same rule over `(txid, table, row)`.
- Exponential backoff with jitter (30 s → 15 min) per transport direction and per refused row.
- A single-flight runner; a committed local change (`pg_notify('sync_outbox')`) or a
  central-side change (long-poll `peek=1&wait=25`) wakes the tick within seconds.
- Idle ticks write no log rows.

## Self-checking

- **Health** (`sync-health.ts` / `-service.ts`, shown on the desktop's sync panel): unsent
  count and age, refused rows, deferred, dead letters, master conflicts, last contact.
- **Drift check**, hourly: settled bills, sales and payments per business day (bucketed by
  `app_business_date` of `opened_at`) are compared with the central server's for the last 7
  complete days, over bills that took part in sync (`orders.sync_state_hlc`). Skipped while
  either side still holds unsettled work.

## Exit criteria — where each is satisfied

- Transport bugs fixed and regression-tested — `integration/sync-events.integration.test.ts`.
- Two-database end to end (real routes, real auth) — `integration/hybrid-sync.integration.test.ts`:
  customer from cloud reaches desktop; concurrent edits to different fields both survive; same
  field, later edit wins; menu both ways without touching derived cost; an edited open bill
  converges; a bill paid after lines were added settles in the cloud; an amendment replays with
  the same line ids and total; a cloud bill reaches the branch without echo; an offline-phone
  bill reconciles; drift check agrees, then reports an injected difference; the pull cursor
  never passes a row still committing.
- Pure rules unit-tested — `master-sync-merge`, `master-sync-registry`, `sync-backoff`,
  `sync-wake`, `sync-health`, `sync-outbox`, `data-ownership`.

## Not in this phase

- Retail invoices and the retail catalogue in hybrid mode.
- Media bytes created on a desktop (menu item images) — metadata only, as before.
- A per-field conflict *inbox*: an unmergeable change (a name clash between two rows created
  independently) is recorded and listed on the panel, and resolved by renaming.
