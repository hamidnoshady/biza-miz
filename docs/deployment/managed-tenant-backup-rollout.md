# Managed tenant backups (#903): rollout boundary

## Required deployment policy

| Trusted profile | Persistent destinations | Backup scope |
| --- | --- | --- |
| Cloud | Platform-managed encrypted cloud copies only | RLS-scoped business snapshot |
| Hybrid | Installation-local + platform-managed encrypted cloud copies | Typed site-physical or central-logical; never interchangeable |
| Local | Installation-local only; no cloud upload or cloud storage charge | Single-business physical backup |

Process role and business deployment profile are different. Resolve both server-side;
never trust a destination, role or business ID supplied by a tenant. Preserve #807:
central tenant operations must never invoke physical whole-database replacement.
Platform disaster recovery is a different subsystem, not tenant inventory.

## Implemented boundary

`/api/backup/config` now returns an explicit tenant schedule DTO, not a masked
supplier configuration. PUT accepts only `enabled`, `intervalHours`, `anchorTime`;
unknown fields (including credentials, destination paths, encryption controls and
retention) are rejected, not silently ignored. Historic stored encryption and
connection settings remain unchanged. Old clients submitting a full config must
refresh. No key migration occurs in this change.

Tenant settings UI contains no connection form or encryption configuration.
`/api/backup/status` no longer serializes artifact paths/object keys or underlying
provider/database errors; internal diagnostics remain in the existing operator
records. Config and status responses are non-cacheable. Historical SQL/XLSX
exports are explicitly not advertised as automatically restorable backups.

## Not a production managed-backup rollout

This security foundation does **not** meet the full epic's definition of done.
Do not advertise managed encryption, portable disaster recovery, managed-only
cloud persistence, or central logical restore as available based on this patch.
Existing storage behavior, billing and restore artifact APIs still require work.
The existing central physical-restore refusal remains mandatory.

Remaining dependent delivery gates:

1. Operator-only tenant-service configuration/capabilities and approved policy
   limits, separate from platform-wide DR. Audit every response (including legacy
   restore inventory/errors), not just config/status, for infrastructure disclosure.
2. Signed/versioned typed manifests, scoped inventory + RLS, encrypted staging,
   managed storage adapters, bounded resumable upload/download/verification and
   cleanup; explicit legacy import/backfill rather than reclassification of SQL.
3. Versioned envelope keys, isolated recovery custody, rotation and portable
   exports; preserve decryptability of historic passphrase artifacts. Never
   invent a DB-only master key or silently fall back to plaintext.
4. Central tenant-only typed-data restore with preview, reauthentication,
   checkpoint, durable journal/lock, target-only write pause, atomic replacement,
   accounting verification and rollback. Never execute uploaded arbitrary SQL.
5. Hybrid durable upload reconciliation, truthful offline availability and sync
   generation fencing; Local must have no outbound cloud path.
6. Existing wallet/catalog integration: successful-only fair settlement,
   idempotent byte-time metering and allowance/retention enforcement. Current
   pre-work manual charging remains an explicitly unresolved gate.
7. Scoped Superadmin `/platform/businesses/[id]/backups` page and APIs with
   separate read/export/restore capabilities, audit and canonical billing links.
8. Component coverage manifest for media and external website state, with honest
   partial/unavailable labels; isolated multi-tenant recovery drills and the full
   cloud/hybrid/local fault-injection and billing matrix before rollout.

## Validation of this slice

- 81 focused contract, architecture, encryption stream and backup tests pass.
- Changed TypeScript/TSX files pass ESLint.
- `tsc --noEmit` passes with a 4 GiB heap (default heap exhausted).
- Full build, database integration and disaster-recovery drills were not run.
- Sandbox Node is 22; the repository requires Node >=24. Production validation
  must use the supported runtime.

## Follow-up: legacy artifact reference boundary

Legacy restore inventory now returns opaque business/destination-bound references,
not supplier object keys. Verify/apply re-resolves each reference against the
selected business's current inventory and requires the artifact to exist. The
reference is not a capability: authorization and single-business gates still run
on every request. Old browser tabs with raw keys must refresh; raw keys are no
longer accepted by the tenant route. Central/multi-business installations return
an empty legacy physical-restore inventory without querying artifact storage.

Manual-run responses omit internal filenames/object keys and raw errors. Restore
errors use a small explicit allow-list; unknown process/provider/database errors
are not echoed. This does not replace the required full upload/export/summary
response audit or service-layer ownership audit. Two additional reference/error
unit tests and the focused 26-test run pass; changed-file lint and TypeScript pass.
No database recovery or cross-tenant integration drill was performed.

## Follow-up: per-business Superadmin metadata section

`/platform/businesses/[id]/backups` now appears in the canonical workspace
navigation and overview shortcuts. Its dedicated GET API requires
`tenant_backup.read` (not `backup.read` or `backup.restore`), checks the selected
business exists, reads that business's `backup_runs` only and audits the view.
Default admin presets receive metadata-read access only. The response excludes
artifact keys, raw error payloads and credentials, and is non-cacheable.

This is deliberately a read-only metadata panel, **not** the completed artifact
manager. Connectivity is unknown for site profiles and availability is always
unverified. Generation success is not called verified recovery. Local profiles
exclude cloud records. Operators can still see historical local records on Cloud
profiles rather than masking the pre-existing persistence policy violation.
The panel links to canonical business billing; no parallel wallet/pricing exists.

Trigger/verify/download/upload/policy/restore actions, independent mutation and
export capabilities, confirmed device metadata freshness, storage allowance,
pricing/cost analytics, searchable artifact inventory and recovery history remain
unimplemented. The presence of this section does not authorize rollout or mean
those requirements are complete.

Validation: 33 focused API authorization/scoping, summary, role and navigation
tests pass; changed-file ESLint and TypeScript pass. API tests mock database and
auth seams and are not a substitute for FORCE RLS integration tests.

## Follow-up: Local network refusal and locked restore ownership

Trusted Local-only profile now overrides historical cloud-enabled settings at
service boundaries: cloud upload exits before loading supplier config, reconnect
catch-up exits without scheduling cloud work, inventory makes no remote list call
and excludes historical cloud rows, and cloud physical restore refuses under its
restore lock before any remote fetch. Local health/history responses suppress
cloud data and tenant UI hides cloud health and cloud restore source controls.
Historical stored configuration is not erased by these checks.

Physical restore now checks successful, business-owned, physical artifact run
metadata under the distributed restore lock, before opening either local or cloud
bytes. Uploaded files still follow their separate business-scoped staging path.
This closes a direct-service-call bypass of route-level inventory resolution; it
is not the new central logical recovery engine and does not enable it.

Five service-boundary tests cover Local network refusal with legacy enabled
settings, owned-key tampering and the unchanged central physical prohibition.
87 focused backup/architecture/encryption/MCP tests pass, as do changed-file lint,
TypeScript and diff checks. These mocked tests do not establish FORCE RLS or
real recovery acceptance. Full build, integration suite and recovery drills were
not run for this increment. All undelivered epic gates above remain open.

## Increment: typed inventory, managed custody, fair settlement, restore preview

This increment builds the managed-service layer the previous slices said was
missing, and deliberately stops short of routing production artifacts through it.

### Delivered

- **Migration 0264** adds four tables, all forward-only and additive:
  `tenant_backup_artifacts` (one row per destination, sharing one `artifact_id`
  so a Hybrid mirror is one backup), `backup_key_versions` (platform-only,
  `subject_business_id`, wrapped per-business artifact secrets),
  `tenant_backup_restore_jobs` (preview/apply journal with an enforced single
  open apply per business) and `tenant_backup_storage_samples` (retained managed
  cloud bytes over time — the evidence behind `backup.storage_byte_day`).
  Every tenant table carries `ENABLE`/`FORCE ROW LEVEL SECURITY` with the
  canonical `tenant_isolation` policy; key custody carries `platform_only` and
  is never readable from a tenant connection.
- **`src/lib/backup-manifest.ts`** — versioned, typed artifact manifests with an
  HMAC signature derived from the platform key-encryption key. Manifests name the
  business scope tag, the format, the schema version, the encryption generation
  and every component as `included` / `external` / `excluded` / `unavailable`, so
  completeness is `partial` unless every declared component was captured. Unknown
  fields, unknown components, a relabelled scope and a newer manifest version are
  refused rather than ignored.
- **`src/lib/backup-key-custody.ts`** — managed encryption custody without
  changing the artifact file format: a generated per-business secret replaces the
  Owner's passphrase, wrapped under the KEK with AES-256-GCM and bound (as AAD)
  to the business and key version. Rotation retires a generation and mints the
  next one; revoked keys refuse to open. Historic passphrase artifacts stay
  labelled `legacy_passphrase_v1` and are never silently reclassified. An
  optional portable recovery envelope lets a tenant open a downloaded artifact
  with a passphrase they hold, for the case where the platform itself is gone.
- **`src/lib/tenant-backup-inventory.ts`** — one provider-neutral inventory over
  the rows: mirrors collapse to one entry with two destination views (no double
  counting), Local-only tenants never see a cloud row, queued uploads are
  `uploading` and never "ready in the cloud", retention expiry is `expired`,
  unverified uploads are not restorable, and nothing carries a key, endpoint,
  bucket, prefix or internal error. Search, filter, sort and pagination are
  bounded (50 per page maximum).
- **`src/lib/tenant-restore-preview.ts`** — the dry-run preview required before
  any central tenant-only restore: affected datasets with incoming and current
  row counts, what is retained because the artifact does not contain it, what the
  artifact admits it never captured, RPO hours, an estimated downtime, the lock
  key, every blocker (collected, not short-circuited) and the exact typed
  confirmation phrase. Physical artifacts are refused on central with the same
  error the #807 guards use; a payload from a newer schema is refused; an
  unsigned or foreign manifest is refused.
- **`src/lib/backup-billing-settlement.ts`** — settlement policy:
  a use charge only after a verified, non-empty success; nothing for a failed,
  cancelled or unverified attempt; one settlement identity per logical backup so
  a local+cloud mirror is not billed twice; time-weighted byte-days for retained
  managed cloud bytes only; and an explicit refund decision for pre-charges that
  the old flow took before doing the work.
- **`/api/backup/run`** now preflights entitlement and affordability, runs the
  work, and settles only on success (`preflightFeatureUse` + `chargeForFeature`).
  The response states the settlement action and reason.
- **New tenant APIs**: `GET /api/backup/artifacts` (inventory, `backup.manage`)
  and `POST /api/backup/restores/preview` (Owner-only `backup.restore`; computes
  and journals a preview, returns `applyAvailable: false`).
- **New Superadmin API** `GET /api/platform/businesses/[id]/backups/artifacts`
  (`tenant_backup.read`, audited as `tenant_backup.artifacts_viewed`) plus the
  matching section on `/platform/businesses/[id]/backups`, showing the managed
  inventory, storage usage against plan inclusion and custody generation — no key
  material, no provider detail.
- **Tenant UI**: a «نسخه‌های پشتیبان این کسب‌وکار» card on the existing backup
  settings surface: status KPIs, state filters, search, pagination, Jalali
  timestamps and an Owner-only preview dialog. The dialog says the apply step is
  not enabled rather than implying a recovery it cannot perform.

### Permission mapping (no new permission keys)

| Action | Permission | Reach |
| --- | --- | --- |
| List/detail inventory, run, verify | `backup.manage` | Owner + Manager |
| Download/export an artifact | `backup.export` | Owner only |
| Upload/register, restore preview, future apply | `backup.restore` | Owner only |
| Schedule, retention, policy | `backup.configure` | Owner only |

### Explicitly NOT delivered by this increment

1. The backup **pipeline** still writes its artifacts with the existing
   configuration (`runTenantPhysicalBackup` / `runTenantLogicalBackup`
   unchanged), so new artifacts are still `legacy_passphrase_v1`. The inventory
   does show them: `tenant_backup_artifacts` rows are merged with a read-only
   projection of successful `backup_runs`, marked `legacy_passphrase_v1`,
   `unverified` and `partial` (unknown coverage), and never restorable until
   something verifies them. Wiring manifest generation, custody key selection,
   secondary-destination registration and the cloud mirror into those two paths
   is the next step; until then nothing is written into
   `tenant_backup_artifacts` by the runner, and a legacy row's preview correctly
   reports `artifact_manifest_missing`.
2. No binary download endpoint, no chunked/resumable upload, no quarantine. The
   inventory marks what would be downloadable; the transport is still the
   existing restore paths.
3. No restore **apply** engine. The preview, journal, guards, lock key and
   checkpoint requirement exist; the two-stage central logical executor
   (decrypt → validate → checkpoint → pause writes → transactional replacement →
   verify → rollback) does not. `POST /api/backup/restores/preview` never
   mutates tenant data.
4. No plan-price/price-version management for backup specifically, and no
   overage invoicing. Settlement decisions and byte-day quantities exist; the
   scheduled job that calls `emitBackupStorageUsage` for a closed period is not
   scheduled.
5. Hybrid reconnect reconciliation, device heartbeat freshness and the sync
   generation fence remain open. The inventory therefore reports connectivity as
   `unknown` off a cloud profile instead of inventing `online`.
6. Media/attachment and external website capture are still `external` /
   `unavailable` in any manifest that mentions them — no bridge yet.
7. Component row counts in the preview cover Accounting, CRM and Growth cores
   only; Website Management components report `null` (unknown, not zero).

### Validation of this increment

Run locally in this sandbox (Node 22; the repository requires Node ≥ 24):

- `npm test` (unit suite) — see the PR for the final counts.
- `npx tsc --noEmit` with the pinned heap.
- `npm run test:design` (design + primitive lint, loading coverage, reference
  screenshots).
- `npm run lint` on the changed files.
- **Not run**: `npm run test:db` (no PostgreSQL in this sandbox),
  `npm run test:visual` (no seeded browser run) and `npm run build`. The migration
  is therefore validated by unit contract tests
  (`src/lib/managed-tenant-backup-schema.test.ts`) and by review, not by an
  applied-migration run or a FORCE RLS integration test. Treat the RLS claim as
  unproven until the DB slice runs.

## Increment: pipeline, transport, apply engine, hybrid, billing, custody, drills

The previous increment built the managed-service layer and said explicitly that
production artifacts did not flow through it. This increment wires it end to end
and closes most of the "not delivered" list above. What remains open is listed at
the end, still explicitly.

### Delivered

1. **Pipeline wiring** (`src/lib/tenant-backup-runner.ts`, `backup-service.ts`).
   Both paths now write through the managed layer:
   - the site physical dump and the central logical snapshot choose a key with
     `artifactEncryptionFor` — managed custody first, the Owner's passphrase only
     as a fallback when the platform holds no key — and **refuse to write** when
     neither exists (no plaintext artifacts);
   - the logical payload is the **typed archive** (`POSTARC1`) from
     `tenant-archive.ts`, never an `INSERT` script;
   - every artifact gets a signed manifest naming format, payload format,
     schema, encryption generation and every component, is registered in
     `tenant_backup_artifacts`, and is re-verified (checksum + signature +
     archive parse) before the run is called a success;
   - the cloud half of a mirror is registered as its own destination row sharing
     one `artifact_id`, so the tenant sees one backup at two destinations.
2. **Managed storage adapter** (migration 0265, `tenant-backup-storage.ts`). The
   destination, region, bucket, prefix and sealed credential are held once for
   the fleet (`platform_tenant_backup_service`, `platform_only`), resolved
   server-side per business, and never readable by a tenant route. Enabling
   managed cloud without a complete destination *and* a platform key-encryption
   key is refused. A self-hosted install that already had its own bucket keeps
   uploading to it (`mode: "legacy"`); Local profiles return
   `unavailable/local_profile` before any configuration is read.
3. **Artifact transport** (`tenant-backup-transport.ts`, four routes).
   - Download is two-step: `POST /api/backup/artifacts/[ref]/download` mints a
     short-lived ticket bound to one business, one reference and one destination
     (`backup.export`, Owner-only); `GET` redeems it and either redirects to a
     time-limited provider URL (cloud) or streams the ciphertext (local).
   - Upload is chunked (`POST /api/backup/uploads`, `PUT …/[token]?offset=`,
     `POST …/[token]/complete`, `DELETE …/[token]`). `offset` must equal what the
     server holds, so a retried piece is rejected rather than duplicated.
   - A completed upload lands in **quarantine** as a `verifying` artifact row. It
     becomes restorable only via `POST /api/backup/artifacts/[ref]/verify`, which
     re-reads the stored bytes, checks the digest and signature and parses the
     archive for this business.
4. **Central tenant-only restore engine** (`tenant-restore-apply.ts`,
   `POST /api/backup/restores/apply`). Phased and journalled
   (`verify_started → verify_succeeded → apply_started → apply_succeeded`, or
   `verify_failed` / `apply_failed_before_swap`), gated on the preview's blockers,
   the typed confirmation phrase and a ≤15-minute re-authentication, serialised
   by `LOCK_KEYS.tenantRestore`, checkpointed as a typed archive of the current
   rows, and applied in **one tenant-pinned transaction** that deletes in reverse
   dependency order and inserts parameterised rows, then re-counts inside the same
   transaction (a mismatch rolls back). Protected tables (`businesses`,
   `platform_admins`, …) are refused by name; a physical dump on central is
   refused; `logical_sql_v1` is refused as a payload format. Rows of another
   business cannot be reached: the archive carries a business id that must match,
   and RLS confines every statement.
5. **Hybrid correctness** (migration 0266, `tenant-backup-hybrid.ts`). A durable
   upload queue (unique per business+artifact, ordered, exponential backoff to a
   cap, `dead` after 8 attempts), a site heartbeat row (`site_generation`,
   `accepted_generation`, last-seen, queue depth) and the sync-generation fence:
   an artifact older than the accepted generation is refused as
   `stale_generation` and marked `superseded`, so a re-imaged laptop cannot roll
   the cloud copy back in time. Tenant inventory connectivity now comes from that
   heartbeat — `online`, `offline` or `unknown`, never a cheerful default.
6. **Superadmin service console** (migration 0265,
   `GET|PUT /api/platform/backup/service`, `POST …/service/check`,
   `/platform/backup/service`). Destination and custody status, "test the
   destination" (one signed list request, provider-neutral result code), policy
   defaults (interval, retention ceiling, keep count, artifact ceiling), audited.
   Secrets are write-only: the view carries `accessKeyHint`/`hasSecretKey`.
7. **Billing jobs** (migration 0267, `tenant-backup-billing-jobs.ts`).
   Hourly storage sampling, nightly byte-day settlement of the completed UTC day
   (`backup.storage_byte_day`, idempotency key includes the window), a per-business
   overage calculation reusing the settlement decision, a legacy pre-charge refund
   reconciliation matched by `metadata.runId` and made unique by
   `wallet_ledger_refund_once`, and a margin report (revenue from the catalog
   price, cost from a stated provider assumption, `not_priced` carried per line).
   `/api/backup/run` now records the run id in the charge's ledger metadata so the
   refund job can match it exactly.
8. **Custody operations** (migration 0268, `tenant-backup-custody-ops.ts`,
   `GET|POST /api/platform/businesses/[id]/backups/custody`). Coverage/loss
   report (which generations an artifact names, which still unwrap, which
   artifacts need a customer passphrase), rotation, **legacy passphrase unlock**
   (prove the passphrase opens the artifact, re-encrypt the same payload under
   managed custody, verify it, then mark the old row `superseded` — the old copy
   is kept, never deleted) and the portable recovery envelope
   (export/open, held only by the tenant).
9. **Manifest coverage** (migration/component list, `backup-manifest.ts`). A new
   `app.data` component means no captured table is filed under a name that lies;
   `media.metadata` counts are real, and `media.attachments` is reported
   `excluded` with the business's attachment count when there are any (the bytes
   are not captured — stated, not implied). `website.wp` is `included` only when
   WordPress tables were actually captured; `external.woocommerce` and
   `external.eshobe_assets` stay `external`.
10. **Granular platform permissions** (`platform-admin.ts`).
    `tenant_backup.verify` (engineer: re-prove an artifact, unlock a legacy one)
    and `tenant_backup.download` / `.restore` / `.policy` (owner-only) sit beside
    the existing `tenant_backup.read`.
11. **Verification** — `tenant-archive.test.ts` (21), `tenant-backup-storage.test.ts`
    (16), `tenant-backup-transport.test.ts` (18), `tenant-backup-hybrid.test.ts`
    (12), `tenant-restore-apply.test.ts` (17), `tenant-backup-runner.test.ts` (15),
    `tenant-backup-custody-ops.test.ts` (5), `tenant-backup-billing-jobs.test.ts`
    (7), `tenant-backup-drill.test.ts` (5),
    `tenant-backup-service-schema.test.ts` (9, migration 0265–0268 DDL contract),
    plus route tests for apply (6) and uploads (10). Fault-injection is unit-level:
    a transaction that throws mid-apply, a row-count mismatch, a journal that
    cannot be written, a truncated upload, a replayed chunk, a stale generation, a
    wrong passphrase, a tampered ticket.
12. **Recovery drills** (`scripts/backup-drill.ts`, `npm run backup:drill`).
    Select → ready → decrypt → parse → preview → portable envelope, non-destructive,
    `--json` for a scheduler, exit 0 only when every step proved something.

### Still open (stated, not implied)

- **No PostgreSQL in this sandbox**, so `npm run test:db` was not run: the RLS
  claim rests on the DDL contract tests and review, not on FORCE RLS behaviour.
  Nor were `npm run build`, `npm run test:visual` or a real drill against a
  populated database run.
- **No S3 endpoint here**, so no upload/download was exercised against a provider;
  the adapter, presigning and signing paths are covered by unit tests and by the
  existing `s3-lite` suite only.
- The scheduled jobs are registered in `server.ts` but have never executed
  against a database in this environment.
- Website *content* capture is still table-based: a WordPress site's own database
  is not reachable, so `external.woocommerce` remains honest-by-declaration rather
  than captured.
- Media **binary** capture remains out of scope and is labelled `excluded`.
