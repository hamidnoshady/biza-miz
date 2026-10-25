# Universal safe import & first-sync reconciliation (issue #1118)

When a business already has records in Bizamiz and/or several external systems,
connecting a provider, installing a plugin, importing a file or re-importing a
dataset must **match, link and review before anything is written**. This is one
shared capability — not a Holoo merge, not a WooCommerce special case — built on
the Data Transfer engine ([data-transfer-engine.md](data-transfer-engine.md)) and
`integration_mappings`.

> **Status: foundation slice.** The shared engine, its tables, the service, the
> product domain end to end, and the tests are in. Wiring each existing importer
> through it, the review wizard, and the remaining domains are listed under
> [What is not built yet](#what-is-not-built-yet). Nothing here changes the
> behaviour of an existing importer until it is wired in.

## The contract

1. **Safe first run.** A populated domain or a new overlapping source is staged
   and reviewed before canonical writes. An empty domain, or records that all ride
   a verified mapping, may take a visible fast path (`evaluateFirstRunGate`).
2. **No silent merges.** A name, phone, e-mail, amount, date or non-unique SKU
   alone is evidence, never a link. Auto-link needs a verified source identity, or
   exactly one candidate on a unique key whose tenant branch, type, unit,
   tracking, variant options and role all agree.
3. **Source identities are preserved.** Many sources may link to one canonical
   row; a verified identity is never silently re-pointed (service refusal *and* a
   database trigger); retiring one is a tombstone, never a delete.
4. **Field authority is explicit.** Financial and stock fields belong to the books
   and are never overwritten by arrival time; presentation and per-store price
   stay with the source. A policy that hands a source financial/stock authority is
   ignored.
5. **No automatic historical financial effects.** A past order/invoice/payment is
   matched on a source id or a trusted reference with the same total, currency and
   lines (`historical_match`); amount and date alone only raise a review item.
   Nothing is posted by the engine.
6. **Non-destructive.** Staging writes only the four tables below. Absence in a
   partial feed is not deletion.
7. **Truthful progress.** "Reconciled" needs every item terminal, none failed or
   waiting, the run `applied`, and the post-apply cross-check.

## Where it lives

| Piece | File |
|---|---|
| Vocabulary (domains, nine outcomes, decisions, run states) | `src/lib/import-reconciliation/types.ts` |
| Identity normalisation, exact Rial/Toman and decimal arithmetic | `normalize.ts` |
| Pure resolvers: product, party, financial document, inventory | `resolvers.ts` |
| Field-authority policy and field diff | `field-authority.ts` |
| Run state machine, first-run gate, stale check, progress, outbound gate | `lifecycle.ts` |
| Batch planner (`planProducts`, …), record fingerprints | `plan.ts` |
| Tenant-scoped service (open → stage → decide → apply → cross-check) | `service.ts` |
| Tables | `migrations/0255_import_reconciliation.sql` |

`types.ts` and `lifecycle.ts` are client-safe; `plan.ts` hashes with `node:crypto`
and `service.ts` reaches the database, so a client component imports only the
first two.

## The outcomes

Every incoming record gets exactly one: `already_linked`, `safe_match`,
`create_new`, `field_conflict`, `ambiguous`, `invalid`, `historical_match`,
`skipped`, `failed`. The owner can **link**, **create separately**, **skip**,
**choose field authority** or **keep for review**; which of those is offered
depends on the outcome (`allowedDecisions`). Overruling the engine
(`create_separate` on an ambiguous record, or giving a source a protected field)
requires a reason on the record. "Approve all safe" touches only `safe_match` and
`create_new`.

## Lifecycle

```
openRun ─► stageProducts … ─► completeProductDiscovery ─► decideItem / approveSafeBatch
                                   │ (gate)                          │
                                   └─ fast path approves safe        ▼
                                                     revalidateRun ─► applyRun ─► crossCheckRun
```

* **One active run per business / domain / source / branch** (partial unique
  index). A second manual sync, webhook backfill or re-upload on the same scope is
  refused with the id of the run that owns it.
* **Staging is idempotent.** Unique on (run, type, key) plus a record fingerprint:
  re-sending a batch is a no-op, a changed record re-resolves and returns to
  review, an applied item is left alone. Duplicate keys that land in different
  bounded batches are found by an `identity_keys` sweep.
* **A stale preview cannot be applied.** `applyRun` re-validates the source
  fingerprint, policy version and canonical-state digest first; a changed one
  marks the run `stale` and sends every approval back to `proposed`. If the source
  or the books cannot be read (offline) the preview is `unverified` and is refused
  unless the caller explicitly accepts that.
* **Apply is resumable.** Bounded batches, `FOR UPDATE SKIP LOCKED`, one savepoint
  per item: a failing item is recorded `failed` with its error and the rest carry
  on; the run ends `applied` only if nothing is pending or failed, otherwise
  `partially_applied`.
* **Domain writes belong to the domain.** The service decides *whether*; an
  `ApplyHandler` (`createProductApplyHandler`) does the write. Its `link` writes
  the source identity (and the `integration_mappings` row for a connection-backed
  source, which the existing sync code reads); `create` is delegated to the owning
  service and fails loudly (`create_not_supported`) if none is supplied.

## What is not built yet

Deliberately left for follow-up changes, in the order they unblock the issue's
acceptance matrix:

1. **Wiring the existing entry points** through a run: the WooCommerce plugin
   first handshake (stage `catalogue_export`/`customer_export`/`orders_export`
   instead of applying them; buffer live events while a run is open), Woo
   `syncProducts`, Holoo `import-plan`/`import-service`, and the Data Transfer
   `import-service` for populated entities.
2. **Review wizard** under Settings → Data Transfer and the reusable Initial
   Reconciliation step in provider onboarding (RTL/mobile), plus the routes and
   permission gate in front of this service. Decisions here record the actor; the
   route enforces who may decide.
3. **DB loaders and apply handlers for party, financial-document and inventory**
   (the resolvers and planners exist and are unit-tested; party loading needs the
   encrypted-field blind indexes, inventory needs the stock/lot/serial readers),
   and category/attribute/media resolvers.
4. **Posting policy / cutover** for historical financial documents (idempotent,
   domain-approved) and the recorded ledger/inventory authority boundary.
5. **Outbound gating** in the Woo/Holoo push queues using `canPublishOutbound`,
   and rejected-remote-edit suppression via `remoteEditFingerprint`.
6. **Downloadable non-sensitive run report**, and Cloud/Hybrid/Offline wiring of
   the stale/unverified labels.
