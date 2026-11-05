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
3. **Artifact transport** (`tenant-backup-transport.ts`).
   - Download is two-step: `POST /api/backup/artifacts/[ref]/download` mints a
     short-lived ticket bound to one business, one reference and one destination
     (`backup.export`, Owner-only); `GET` redeems it and either redirects to a
     time-limited provider URL (cloud) or streams the ciphertext (local).
   - The **tenant** upload surface is deliberately gone (`2026-10-30`): business
     users do not upload backups *as inventory*, and §2 says so explicitly. What
     was `POST /api/backup/uploads`, the chunked `PUT/DELETE …/[token]` and
     `POST …/complete`, plus the tenant `POST /api/backup/artifacts/[ref]/verify`,
     were removed with their chunk validators rather than hidden — the chunked
     upload a business *does* have is the restore-file transport
     (`/api/backup/restore/upload`, site installs), which is a recovery step, not
     a management one. The `tenant_backup_upload_sessions` table stays as history
     (migrations are forward-only) and is no longer written.
   - Restoring a business from a file it downloaded earlier is delivered: the
     checklist item is the *two-file recovery pair* described under
     "restoring from a file the platform never wrote" below, because the
     signature — not the tenant's word — is what makes the file believable.
4. **Central tenant-only restore engine** (`tenant-restore-apply.ts`,
   `POST /api/backup/restores/apply`). Phased and journalled
   (`verify_started → verify_succeeded → apply_started → apply_succeeded`, or
   `verify_failed` / `apply_failed_before_swap`), gated on the preview's blockers,
   the typed confirmation phrase and a ≤15-minute re-authentication, serialised
   by `LOCK_KEYS.tenantRestore`, checkpointed as a typed archive of the current
   rows, and applied in **one tenant-pinned transaction** that deletes in reverse
   dependency order and inserts parameterised rows, then re-counts inside the same
   transaction (a mismatch rolls back). The replay runs with
   `session_replication_role = replica` (SET LOCAL, this transaction only): the
   business's own triggers police live mutations and refuse a faithful replay —
   the order-item guard rejects even the DELETE of an item belonging to a
   completed order — so a role that cannot set that parameter makes every
   business with a closed order unrestorable. `npm run db:app-role` grants it
   (`GRANT SET ON PARAMETER session_replication_role`), and a restore on a role
   without it refuses up front as `restore_requires_trigger_bypass` rather than
   half-restoring. Protected tables (`businesses`,
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
   are not captured — stated, not implied; see
   [`media-binary-capture.md`](./media-binary-capture.md) for what capturing them
   would cost). `website.wp` is `included` only when
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
- Media **binary** capture remains out of scope and is labelled `excluded`. It is
  now the only unimplemented item of the epic, and it is blocked on a design
  decision rather than on effort: an artifact is one signed file of known size and
  media lives in a second storage system, so capture changes retention, reclaim,
  billing byte-days and the import contract together. The options, the
  recommendation and the four decisions only the owner can make are written up in
  [`media-binary-capture.md`](./media-binary-capture.md).

## Increment: tenant surface superseded (issue #903 §10, first P0 line)

The owner decision of 2026-10-28 says a business user does not manage backups.
The code now says the same thing, and the *routes* are gone rather than merely
unlinked from the UI — hiding a control in the browser is explicitly not what
the epic asks for.

**Removed**

- `POST /api/backup/run` («پشتیبان‌گیری هم‌اکنون»). No tenant-triggered run,
  no per-use wallet debit, no manual trigger that bypasses the schedule.
  `runBackupNow`/`runLocalBackup` remain for the platform path and the
  scheduler, which are the only callers a managed service should have.
- `PUT /api/backup/config` — schedule, interval, retention and local paths are
  no longer tenant-writable in any deployment. `GET` stays and is read-only:
  it reports the policy in force plus `editable: false`, and a stale client's
  `PUT` now gets the framework's 405 instead of a silent no-op.
- The «تنظیمات پشتیبان‌گیری» card, the interval/retention/folder form and the
  run-now button in `/dashboard/backup` (and therefore `/settings/backup`).
- The two tenant AI/MCP verbs that wrapped them — `backup.config.set`
  (`write_backup_config_set`) and `backup.run_now` (`write_backup_run_now`),
  with their registry entries, capability map and coverage rows. A model cannot
  reach a capability the product no longer offers. `backup.restore.apply` stays:
  restoring your own verified backup is allowed, creating one is not.

**Kept, deliberately**

- Read-only status, artifact inventory, download/verify, restore (cloud or
  file, behind preview + re-auth + typed confirmation) and the Owner data
  export — the surface §2 permits.
- The Owner Recovery Kit (desktop), which used to live inside the schedule
  card. It recovers *local* encrypted fields and sync credentials, a different
  key from any artifact's; it is now its own card.
- Onboarding. The wizard step at `/setup/backup` still writes the **safe
  on-device defaults** (§1) for a single-business site install, through a new
  `GET|PUT /api/setup/backup` that refuses a central deployment outright
  (`not_site_install`) and accepts only the same narrow allow-list as before.
  This is the install engineer's one-time choice, not a tenant setting.

**Where the schedule now comes from**

`resolveTenantBackupPolicy()` (`tenant-backup-storage.ts`) reads
`platform_tenant_backup_service` — platform-only, never tenant-writable — and
returns the interval, retention ceiling and keep count. It falls back to
documented safe defaults (24 h, 30 days, 30 copies, `source: "default"`) only
when that row cannot be read at all. Both scheduler ticks and the health DTO use
it; neither reads the tenant's former `intervalHours` any more. Managed
scheduling is switched on by the fleet (`managed_cloud` with a usable
destination) even where a business had once disabled its own schedule, and the
status card shows the cadence and retention read-only with one sentence saying
who decides them.

**Unchanged and still open**: everything listed under "Still open" above —
notably the absence of PostgreSQL/S3/Node ≥ 24 in this environment, so the
integration suite, `test:db`, `build` and a live drill remain unexecuted here.

## Increment: Superadmin per-business operations (issue #903 §10, third P1 line)

`/platform/businesses/[id]/backups` was a read-only metadata page. It now acts,
through a new `platform-tenant-backup-ops.ts` and four route files, each with its
own capability and audit entry:

| Route | Capability | What it does |
| --- | --- | --- |
| `GET  …/backups/diagnose` | `tenant_backup.read` | Policy in force, destination resolution (including the legacy-bucket case), custody generation and KEK presence, managed bytes, queue depth, device heartbeat, artifact-state histogram and a list of `actions` codes |
| `POST …/backups/run` `{action:"run"}` | `tenant_backup.verify` | The shipped `runBackupNow` — same pipeline, same gates, no tenant charge |
| `POST …/backups/run` `{action:"catch_up"}` | `tenant_backup.verify` | Drains the durable upload queue with its own backoff and generation fence |
| `POST …/backups/artifacts/[ref]/verify` | `tenant_backup.verify` | Re-reads the bytes (local file, or a fresh staging copy of the cloud object), checks checksum + signature + archive parse, then `ready` or `failed` |
| `GET  …/backups/artifacts/[ref]` | `tenant_backup.download` | Streams a local artifact or redirects to a 5-minute presigned URL; never returns a key |
| `DELETE …/backups/artifacts/[ref]` | `tenant_backup.policy` | Retention delete, refusing to cross `protected_recovery_copies` |

Design points worth keeping:

- **Logical backups, not rows, are counted for protection.** A mirror's local and
  cloud halves are one backup; destroying the second half of the last backup is
  impossible just because two rows existed.
- **Verify is the way back.** It deliberately does *not* apply the download
  plan's "must be ready" rule — verifying an artifact a failed run left `failed`
  is the point — but it still resolves the reference against the path business,
  so another tenant's reference is simply not found.
- **Delete is retention, not destruction.** Bytes are removed, the row becomes
  `expired` with `failure_code = deleted_by_operator`, and a storage failure is
  reported as `storage_delete_failed` rather than as success.
- **No charge.** An operator action is not a billable tenant use; §8 bills
  verified managed byte-days.
- **The console never starts a tenant restore.** That stays with the Owner on the
  tenant route, after re-authentication, exactly as before.

**Deliberately not delivered: `import/register`.** A backup the platform did not
write has no signed manifest and no component list, and the epic forbids
inventing one — so an "import" button could only either trust an operator-supplied
manifest (which the inventory would then present to the tenant as a verified
backup) or fabricate coverage. Neither is acceptable. Artifacts already inside
the platform's own lanes are covered by `verify`; anything else must be restored
through the file-restore workflow, which validates before it applies. If the
capability is wanted later, the honest form is a sidecar manifest written next to
the artifact at capture time, which is a pipeline change rather than a button.

## Increment: the gaps the checklist still named (issue #903 §3)

Four items the epic lists and the service could not yet do.

**1. The Owner can apply a logical restore.** The apply engine shipped with no
caller: the inventory offered a dry run whose own copy promised a confirmation
step that no button performed. `/settings/backup → نسخههای پشتیبان` now offers
the apply inside the preview, and only when the server's own preview says
`canApply` with no blockers. It stays disabled until the typed phrase matches the
server-derived one (the business name). A stale session comes back as
`reauthentication_required`, which opens the shared step-up prompt and re-reads
the preview afterwards — no sign-out needed. Every refusal has its own sentence,
including `restore_approval_required`; success reports tables/rows written and
refreshes the inventory.

**2. The AI verb reaches the same engine.** `backup.restore.apply` gated on
`restoreAvailable()` — the *physical, single-tenant* capability — so on a central
deployment it answered `restore_not_available` while a logical engine sat behind
it. On central it now computes the real preview through `previewOwnedRestore`,
returns it with `owner_reauthentication_required`, and leaves the apply to the
Owner in the app: an executor cannot prove a fresh re-authentication, and
inventing one would defeat the epic's own gate. A site install keeps the physical
replacement, still behind `restoreAvailable()`.

**3. Per-business policy overrides** (migration 0269,
`tenant_backup_business_policy`, platform-only). `resolveTenantBackupPolicy(
businessId)` merges the fleet row with the business's override and **clamps** it
to the fleet's envelope: retention cannot pass `max_retention_days`, the keep
count cannot exceed `cloud_keep_count`, and the cadence must be one the scheduler
can express. A NULL column means "inherit", not zero. The override reaches the
pipeline, not only the console: `retentionUntilFor` and both scheduler ticks read
the business's own policy. `GET|PUT|DELETE /api/platform/businesses/[id]/backups/
policy` (capability `tenant_backup.policy`) shows the effective policy beside the
fleet envelope, audits the **effective** before/after numbers (so clamping is
visible), and `DELETE` returns the business to the fleet policy.

**4. Recovery approvals** (`tenant_backup_restore_approvals`, platform-only).
A named, expiring, single-use consent for one artifact, granted by a Superadmin
with `tenant_backup.restore` through `…/backups/approvals`. **Off by default**:
the apply route only checks when that business's `require_restore_approval` is
on, so no existing restore changed behaviour. The consent is consumed by a
conditional update *after* a restore commits, so a failed attempt never burns it,
and a consumed approval cannot be revoked — the restore it authorised already
happened.

**Still open.** Media binaries, the
WordPress/WooCommerce database, and the whole "Real acceptance" line: no
PostgreSQL, S3 or Node ≥ 24 here, so `test:db` (including the extended RLS
suite), `build`, and a live drill remain unexecuted in this environment.

## Increment: three knobs that were not wired (issue #903 §3, §12)

Settings the console showed or the repo shipped that nothing consumed.

**1. `max_parallel_uploads` now bounds real work.** The fleet row has carried the
number since 0265, the console showed it, and `drainUploadQueue` ignored it: the
queue was strictly one artifact per tick, per business. It now plans the whole
queue in order (backoff, dead letters and the generation fence are decided
sequentially, before any upload starts) and then runs up to
`min(fleet value, MAX_UPLOAD_CONCURRENCY = 16)` uploads together. The default —
`1` on a fleet row nobody has touched, `2` in `SAFE_TENANT_BACKUP_POLICY` — keeps
the historic behaviour, so no deployment changes speed by upgrading.

**2. The device remembers the policy it was told.** A site install that could not
read the fleet row used to fall back to a hard-coded 24 h / 30 days, which is a
guess: an operator who had set 6 h / 90 days got a silently different protection
level the moment the platform was unreachable. `tenant-backup-policy-cache.ts`
writes every policy the platform actually answered with (never a default) to
`backups/tenant-backup-policy-cache.json`, keyed **per business** so one
business's override can never be handed to another, and expires an entry after
30 days so a device offline for months does not claim to follow a policy nobody
has confirmed. `resolveTenantBackupPolicy` reports `source: "cached"` in that
case, the health payload carries it, and the tenant card says so in words rather
than presenting a remembered number as the platform's current one. When the
platform answers again the entry is simply rewritten — the platform is always
authoritative while reachable, so there is no merge rule to get wrong.

**3. Drills run on a schedule.** `npm run backup:drill` existed and nothing ran
it. `tenant-backup-drills-job.ts` runs from `server.ts` on an hourly tick, drills
every business with a `ready` logical artifact at most once a day
(`DRILL_INTERVAL_MS`; since 0280 the cadence is the plan's
`drill_interval_hours`, idempotent through the new `tenant_backup_drills` table
rather than through a lock alone), writes what it proved, and notifies the Owner
through the new `backup.drill_failed` catalogue event when a backup that exists
does not open. Two honest details:

- The platform holds no tenant recovery passphrase, so the `portable_envelope`
  step is **skipped by design** in a scheduled run and recorded in
  `missing_steps`. `drillVerdict(steps, required)` takes the narrowed list, so a
  routine skip is not a nightly false failure while a failure of any step the
  platform *can* prove still fails the drill.
- 0270 is tenant-readable for its own business and platform-only for writes: a
  tenant can see "my last drill passed", and cannot manufacture that sentence.
  `diagnoseBusinessBackup` now reports the last run and adds `drill_failed` to
  `actions`, which the Superadmin page renders.

**Still open.** Media binaries and the WordPress/WooCommerce database. The drill
question is closed: `integration/tenant-backup-acceptance.integration.test.ts`
runs real drills on a pull request — a migrated PostgreSQL, an unprivileged app
role so RLS actually filters, and a path-style S3 stand-in that can be taken down
or made to store part of a body — inside the ordinary integration shards.

## Increment: per-plan policy, alert thresholds and DR objectives (issue #903 §3)

The epic asks for "default and **per-plan** automatic schedules, retention,
capacity, alerts and disaster-recovery thresholds". Until this increment the
scheduler knew exactly two layers: one fleet row and a per-business override.
That is enough for exceptions, not for a product sold in tiers — shaping
«حرفه‌ای» to six-hourly protection meant editing businesses one at a time.

**The model (migration 0280).** `tenant_backup_plan_policy` is keyed by
`billing_plans.key` and every column is nullable, so a plan states only what it
decides; the four threshold columns also landed on
`platform_tenant_backup_service` so a fleet has a default before any plan exists:

| column | what it decides |
| --- | --- |
| `interval_hours` | scheduled cadence for every business on the plan |
| `retention_days`, `cloud_keep_count`, `max_artifact_bytes` | retention and capacity |
| `protected_recovery_copies` | the floor retention may never prune below |
| `alert_stale_hours` | hours without a success before the Owner alert says stale |
| `alert_failure_streak` | consecutive failures that turn a retry into an alert |
| `drill_interval_hours` | how often the recovery drill re-proves restorability |
| `dr_rpo_hours` | the recovery-point objective the plan promises |

Resolution is **fleet → plan → per-business override**, and every layer is
clamped to the one above it. The clamping rule is the interesting part and it is
deliberately per-field, because "tighter" is not the same direction everywhere: a
plan may back up *more often*, keep *fewer* bytes, retain *less*, alert *sooner*,
require *fewer* consecutive failures, drill *more often* and promise a *shorter*
recovery point — and it may keep **more** protected copies. A sales tier is not a
way to buy weaker protection, so a row that asks for the looser direction is
clamped to the fleet's number rather than obeyed, and
`tenant-backup-plan-policy.test.ts` asserts each clamp from both sides.

**What now reads it.**

- **Scheduling.** `resolveTenantBackupPolicy` applies the plan layer before the
  override, so the run-now, upload and retention paths that already asked for a
  policy get the tier's cadence with no second lookup. The stale window a cadence
  implies is recomputed after the layering: an hourly tier is not held to a
  nightly window (which would never alert), and a daily one is not judged hourly
  (which would alert constantly).
- **Alerts.** `computeBackupAlert` takes the two thresholds and the evidence they
  are judged against — trailing consecutive failures, now read from
  `backup_runs` in the same query as the last run. Both are clamped inside the
  function as well as in the resolver: a configured window is never *shorter*
  than the cadence (that would flag healthy backups) and a streak below one means
  "one failure is enough", never "never alert". With no thresholds supplied the
  behaviour is byte-for-byte the pre-#903 rule, which is what keeps every existing
  fleet unchanged.
- **Drills.** `runScheduledBackupDrills` resolves each candidate's plan cadence
  through a single join (`readEffectiveBackupThresholds`), so a tier can prove
  restorability every two hours; an unreadable policy answers the daily default
  rather than stopping the job.
- **DR objectives.** `diagnoseBusinessBackup` now reports
  `dr: { rpoHours, newestVerifiedAt, ageHours, breached }` and adds
  `dr_rpo_breached` to `actions` when the newest **verified** backup is older
  than the objective. Verified is the point: an artifact that exists but has
  never been re-read is not a recovery point, so it cannot satisfy the target. A
  fleet that promises nothing reports `rpoHours: null` — unset, not met.
- **Console.** `/platform/backup/service` gained the four fleet thresholds and a
  «سیاست هر طرح» card that lists every plan in the catalogue (including the ones
  that never decided anything) and edits one at a time, showing the fleet's
  number beside each field so "tighter" is a visible comparison. Empty means
  inherit. `PUT`/`DELETE /api/platform/backup/service/plans` are
  `tenant_backup.policy`-gated and audited with before/after; an unknown plan is a
  404 rather than a row no business can inherit, and an unknown field is a 400
  rather than a silently dropped setting.

**Honest limits.** The offline policy cache keeps its pre-0280 format: an entry
written before the thresholds existed stays valid and the reader derives the
pre-#903 answer (cadence window, alert on first failure, daily drill, no RPO), so
a device that upgrades while offline does not lose the cadence it was honouring.
A plan policy is not exposed to a tenant at all — the table and the thresholds are
`platform_only` under FORCE RLS, and the tenant sees only the consequences: a
cadence, an alert that fires or does not, a drill that ran.

## Increment: the margin report gets a route (issue #903 §3, §8 — and a SQL bug found on the way)

§3 makes provider-cost monitoring a Superadmin job. `computeBackupMargin` and
`backupMarginReport` had existed since the billing jobs landed, with unit tests
over the arithmetic — but nothing called them, so "what does managed storage earn
against what it costs us" was answerable only from a shell.

**The query did not work.** Reading it properly before wiring it up turned up the
reason the gap had never been noticed: `backupMarginReport` selected
`SUM(quantity), SUM(amount_rial) FROM usage_events`. There is no `usage_events`
table and no `amount_rial` column. The billing runtime splits the two — quantity
on the append-only `billing_usage_events`, money in `billing_usage_ratings`
(`rated_amount_rial`, one row per event, keyed by `usage_event_id`) — so the
report would have thrown on its first call. It now joins them, and the join is
1:1 on a primary key, so a quantity cannot be multiplied by a second rating. That
correction is covered by `integration/tenant-backup-margin.integration.test.ts`,
which seeds priced, unpriced and out-of-window events against a real PostgreSQL:
arithmetic tests cannot see a table name.

**Three honesty rules the route enforces.**

1. *The cost is an input, never a constant.* `providerCostRialPerGbMonth` comes
   from the query string and defaults to `DEFAULT_PROVIDER_COST_RIAL_PER_GB_MONTH`
   (zero), which the report echoes back in `assumptions`. The panel says so in
   words: with no stated cost, "margin" is revenue, not profit.
2. *A partly rated line is neither priced nor flagged.* A business whose meter
   has some priced and some unpriced events has revenue, so it is not
   `notPriced`; the line now also carries `unpricedByteDays` — the exact quantity
   its revenue does not cover — and the table prints it under the figure. A line
   with no rating at all keeps `notPriced: true` and reports zero revenue plus a
   null percentage, which is "unknown", not "free".
3. *A window nobody asked for is refused.* `resolveMarginWindow` defaults to the
   last 30 days, treats a date-only end bound as the end of that day (so "1 to 31
   October" includes the 31st), accepts full timestamps, and answers
   `invalid_window` / `window_too_long` (over 366 days) rather than scanning
   silently.

**The surface.** `GET /api/platform/backup/service/margin?from=&to=&providerCostRialPerGbMonth=`
returns `{ report }` with `Cache-Control: no-store`. It requires
`tenant_backup.policy`, not `tenant_backup.read`: a cost figure is commercial, the
same trust that sets the storage policy and the supplier cost, exactly as the
managed-SMS wholesale numbers are absent from the commercial catalogue. The
console card «گزارش حاشیهٔ سود ذخیره‌سازی» sits last on `/platform/backup/service`
(it reports on the service rather than configuring it), uses Jalali pickers with
ISO on the wire, and renders per-business rows sorted by margin.

**Honest limits.** Nothing is stored and nothing is billed from here: the report
reads settled usage events and touches no wallet, price or invoice. Revenue is
what the rating recorded, so a meter the platform never priced reads as unpriced
rather than as profit — which is the point. The provider cost is not persisted,
so an operator states it each time; if the owner wants it remembered, that is a
column on the fleet row and a separate decision.

## Increment: artifact lifecycle — Cloud keeps nothing local, and retention is enforced

Two gaps the epic names and nothing closed: a Cloud deployment kept a second copy
of every tenant backup on its own disk (§1), and `retention_until` was written on
every artifact and never read (§7), while the byte sample billed expired bytes
anyway (§8).

**`tenant-backup-lifecycle.ts`** owns "remove it". One hourly tick
(`server.ts`, every role) runs three passes per business:

1. **verify** — cloud copies registered `verifying` are re-read from the
   provider, checked (checksum, manifest signature, archive parse) and promoted
   to `ready`. This is the "later verify pass" the upload path has always
   promised and nothing performed, which is why a Cloud backup never became
   restorable without an operator clicking verify. Bounded to
   `VERIFY_BATCH = 2` per business per tick; a transient provider failure leaves
   the row alone (the next tick retries) and only bytes that arrived and failed
   their own checks mark a row `failed`.
2. **reclaim** — on a **Cloud** profile with a **managed** destination, once the
   cloud copy is `ready`, the staged local twin's file and row are removed. The
   backup itself does not disappear: same `artifact_id`, still restorable. The
   row is *deleted*, not marked `expired`, because `expired` outranks `ready` in
   the inventory's precedence and would make every cloud backup read as expired.
   Hybrid and Local keep their local copies, and a legacy self-hosted bucket is
   not platform-managed storage, so it is left alone.
3. **expire** — rows past `retention_until`, oldest first, grouped by
   `artifact_id` so a mirror expires as one backup, and never crossing
   `protected_recovery_copies` (counted in distinct restorable backups, not
   rows). **Bytes first, always**: a row is marked `expired` only after the file
   or object is gone, so the platform can never stop showing a backup it is
   still storing and still paying for. A failed removal is counted and left
   alone, never recorded as a deletion.

`recordStorageSample` now excludes `expired` rows (and the settlement's
"has cloud bytes" test does too), so a business stops being billed the moment its
retention-retired bytes are actually removed.

**Path fix found on the way, same defect in three places.** On central a tenant's
artifacts live in `backups/tenants/<scope>/`, but the operator verify/delete
path, the operator diagnosis and the tenant download plan all resolved
`config.directory/<ref>` — the flat root a *site* uses. They now go through
`tenantBackupDir`, so a central local artifact is found instead of reported
`artifact_missing`. Regression tests cover the tenant download and the sweep.

**New diagnosis code.** `cloud_unverified` appears for a business with a cloud
copy the platform has not read back yet, so the console says "not yet proved
restorable" instead of showing an unverified row as fine.

**Still open.** Cloud's file-restore (`/api/backup/restore` and the chunked
upload remain physical, site-only, exactly-one-business), the tenant upload
endpoints that §2 forbids, post-restore accounting/permission checks, and the
real acceptance matrix — unchanged by this increment. (Per-plan schedules and
alert thresholds landed in the 0280 increment; the margin report got its route in
the increment below.)

## Increment: the tenant upload surface is removed, not hidden (§2, §10 P0)

§2 lists "backup uploads as managed inventory" among the controls a business user
must not have. Four tenant endpoints implemented exactly that, and nothing in the
app called any of them:

| Removed | Why |
| --- | --- |
| `POST /api/backup/uploads` | started a chunked upload into the business's own artifact inventory |
| `PUT`/`DELETE /api/backup/uploads/[token]` | appended/discarded pieces of that upload |
| `POST /api/backup/uploads/[token]/complete` | registered the finished file as a `verifying` artifact row |
| `POST /api/backup/artifacts/[ref]/verify` | let the *tenant* promote its own upload to restorable |

With them went the chunk validators only they used (`checkChunk`,
`checkCompletion`, the `UPLOAD_*` ceilings) — the restore-file transport a
business legitimately has is `/api/backup/restore/upload` plus
`POST /api/backup/restore`, which is a recovery step on a site install and has its
own (tested) chunk validation. Two divergent chunk validators would have drifted.

The `tenant_backup_upload_sessions` table (0265) stays — migrations are
forward-only — but nothing writes it any more.

**Import was left undelivered here, deliberately.** At the time, a file the
platform did not write had no signed manifest, so registering it on an
operator-supplied manifest would have presented unverified bytes to the tenant as
a verified backup, which §4 forbids. It needed a designed feature, not a route to
bolt on — and it got one: see "restoring from a file the platform never wrote"
below.

## Increment: a restore must never rewind the wallet (§5, §8) — found while auditing the apply path

The archive is captured table by table from everything carrying a `business_id`,
and the money tables carry one. So the shipped apply engine would, for a business
restoring a two-week-old backup:

- **delete and refill `business_wallets`** — `balance_rial` back to the balance of
  that day, silently refunding every charge since;
- **delete and refill `wallet_ledger`** — the entries that explain the difference
  gone with it;
- **delete `billing_usage_events`** — the table whose `event_id` *is* the
  idempotency identity, so the next settlement could re-charge a window it had
  already charged because the evidence it had was deleted.

§5 says a restore "must prove … the canonical wallet is unchanged". That is now
true by construction rather than by inspection: `RESTORE_IMMUTABLE_TABLES`
(`business_wallets`, `wallet_ledger`, `billing_usage_events`) is passed to
`applyTenantArchive` as `skipTables`, so **no statement is issued** against them.
The row-count verification skips them too (otherwise every restore would fail its
own post-check), and the `apply_succeeded` journal entry records
`untouched: [...]`, so an auditor reading the receipt cannot conclude the wallet
was restored.

Note this was reachable in production *only* because the apply button was added in
`53f78cd` — the engine had no caller before that, which is exactly the kind of
latent hazard that a Prettier-only diff review cannot see.

**Still open in §5:** the checks either side of the money rule — accounting
consistency after the swap, permission/membership reconciliation, and sync
fencing verification — are not implemented. The epic also wants a *proof* (a test
that another business, the platform realm and the canonical wallet are unchanged)
which needs `npm run test:db` and therefore PostgreSQL.

## Increment: the acceptance matrix is executable (§10, last P0)

§10's closing line asks for "real acceptance" across Cloud, Hybrid
(online/offline/reconnect), Full Offline, corruption, S3 outage,
huge/interrupted files, lost keys/device, concurrency, retention, billing and
multi-tenant drills. Every one of those had *unit* coverage; none had been run
end to end against a real PostgreSQL and a real provider, which is the only
arrangement where the pieces are wired to each other rather than mocked apart.

`integration/tenant-backup-acceptance.integration.test.ts` (10 cases) is that
matrix. It provisions a database with the full migration set, connects as the
unprivileged app role so row-level security really filters, serves a path-style
S3 endpoint on localhost that can be told to go down or to store only part of a
body, configures the managed service through the console's own write path
(sealed credentials under the platform KEK), and drives three businesses on the
three profiles.

| Acceptance row | What the matrix proves |
| --- | --- |
| Cloud | upload → managed object exists → the inventory has **one** restorable entry → the staged local twin is reclaimed → the verifier and a full drill both open the stored object |
| Corruption | damage applied to the object *after* the upload is caught by the verifier (`artifact_checksum_mismatch`) and the drill fails at decryption — a `ready` row is not by itself "we can restore you" |
| Interrupted / short object | a provider that stores part of a body is caught by the same verifier; the row is never promoted by an HTTP 200 |
| S3 outage | the upload is recorded `failed`, nothing is invented in the bucket, the artifact is queued, and the operator's catch-up drains the queue **without taking a second backup** |
| Full Offline | zero S3 requests, zero `billing_usage_events`, a restorable local artifact, and an honest `restore_preview` blocker (`artifact_unavailable_offline`) because a Local profile has no logical apply path yet |
| Hybrid | offline: local copy survives and the mirror fails; reconnect: the same artifact is mirrored, both rows stay, and both share one `artifact_id` |
| Lost keys / device | a deleted custody generation fails the drill at decryption rather than at restore time, and the custody readout reports no active generation |
| Concurrency | two simultaneous backups are one `ok` and one `busy`; one row; a repeated settlement window is a `duplicate`, not a second charge |
| Retention | an expired-but-last backup is protected: `expired = 0`, `protectedSkipped ≥ 1`, rows unchanged |
| Multi-tenant drills | each business drills its own artifact, the other's ref is unresolvable in this scope, and A sees no local row for B |

Narrower owners stay where they are: `tenant-restore-apply.integration.test.ts`
owns the destructive apply (lock, journal, rollback, cross-tenant) and
`tenant-backup-isolation.integration.test.ts` owns the #807 admission guards.
This suite does not restate them.

### Two defects the matrix found (both fixed here)

1. **The lifecycle tick never ran inside a tenant scope.** It listed businesses
   through a documented bypass, then called the verify / reclaim / expire passes
   with no scope at all. Under the RLS-enforcing app role every statement saw
   zero rows, so the hourly scheduler verified nothing, reclaimed nothing and
   expired nothing — a silent no-op that unit tests with a stubbed `query` could
   not see. `runBackupLifecycleTick` now wraps each business's passes in
   `withTenant(businessId, …)`, and the unit suite asserts the scope is opened
   once per business.
2. **Every managed backup appeared twice in the tenant inventory.** A managed
   artifact always has a matching `backup_runs` row, and the legacy projection of
   that row is namespaced (`<destination>:<name>`) so the existing dedupe by
   opaque ref could never match it. The tenant saw their backup once as
   restorable and once as an unverifiable "legacy" copy — and on Cloud, after
   reclaim, a phantom `local` entry for bytes that were deliberately deleted.
   The merge now also drops a legacy row whose artifact file name is registered,
   whatever the destination.

### Behaviours the matrix pins, deliberately

- **The mirror path registers the cloud copy `ready` on the upload's payload
  hash**, so it never enters the `verifying` queue; `pendingVerificationCount` is
  `0` for it. The bytes are therefore proved by the verifier or by a drill, not
  by the verifier, by a drill, or by the **drift sweep** (below). Registering the
  mirror `verifying` instead was the other option and was rejected: it would
  delay Cloud's reclaim by a tick and keep two copies of every tenant's data on
  the app server, which §1 forbids for Cloud.
- **A Local profile's logical artifact has no apply path**, so its drill reports
  `restore_preview` failed with `artifact_unavailable_offline` while
  `report.ok` is true for the steps the platform can prove. That is the honest
  label, not a pass.
- **Scheduled drills never prove `portable_envelope`**: the platform does not
  hold the tenant's recovery passphrase, so the scheduler narrows
  `requiredSteps` and the step reports `skipped`.

### Still open after this increment

Nothing from this increment. Both items — scheduled re-verification of mirrored
cloud objects and the `config.cloud.enabled` gate — were delivered later; see
"the drift sweep and one gate for the mirror" at the end of this document.

## Billing: why `backupUseChargeDecision()` is not wired (§3, §7)

`backup-billing-settlement.ts` has always exported a pure **per-use** decision —
`backupUseChargeDecision()` returns `action: "charge"` with an `amountRial` for a
verified, success, priced attempt, and `none` for a failed, cancelled, unverified,
empty or already-settled one. Nothing calls it, and that is now the intended
state, not unfinished work:

- the tenant's "run a backup now" endpoint was **removed** by owner decision
  (`billing-guard.ts`, see "the tenant surface superseded" above), so there is no
  billable *use* left to charge for;
- managed backups are billed from **retained byte-days** —
  `backup.storage_byte_day`, `byteDays × price ÷ (1024³ × days in the month)` —
  which is what `runBackupStorageSampleJob` + `runBackupStorageBillingJob`
  settle, and what the margin report (`/api/platform/backup/service/margin`)
  reads back;
- the function stays in the tree because it is the tested contract a future
  per-use product would need, and deleting it would delete the only written
  statement of *when a backup may be charged at all* (verified success only).

Its sibling **is** wired: `legacyPrechargeReconciliation()` backs
`runBackupLegacyRefundJob` (daily, central), refunding a pre-charge from before
this policy for an attempt that failed or never verified — exactly once, keyed by
`settlementKey(…, "refund")`.

**Was an observation, now fixed.** `tickBusiness` (`backup-service.ts`) used to
let the tick proceed when `config.enabled || managedSchedule`, but upload the
artifact it had just taken only when the tenant's legacy `config.cloud.enabled`
flag was set — two gates for one decision, so a managed Cloud tenant whose legacy
field was never set kept its only copy on the app server for a whole interval and
mirrored on the *next* non-due tick through `maybeCatchUpCloud`. The mirror now
follows the resolved **destination** instead: see the last increment.

## Increment: restoring from a file the platform never wrote (§2 item 4, §6)

Every other path starts from an inventory row, because the platform holds the
artifact and can resolve a reference. The Owner's worst case is the opposite —
the server was reimaged, the bucket was deleted, the business was cancelled — and
what survives is a file on a laptop. Nothing in the database names it.

The unit of recovery is therefore a **two-file pair**, which is what the custody
model actually allows:

- the encrypted payload the Owner already downloads, plus
- `GET /api/backup/artifacts/[ref]/manifest`, which serves that artifact's
  **signed** manifest (`<ref>.manifest.json`), Owner-only `backup.export`, no
  provider detail.

`POST /api/backup/restores/import/upload` + `POST /api/backup/restores/import`
take both, and register the payload as this business's `uploaded`/`verifying`
artifact. The ordinary verifier then promotes it through the same checksum +
signature + archive-parse gate every other artifact passes, and the ordinary
preview/apply path restores it — **the import adds no second way to write a
business's rows**.

What it refuses, in the order it refuses it: a payload that is not
`tenant_archive_v1` (a `.sql` dump is refused by name — nothing here executes
text from a file); a manifest whose signature does not verify under the platform
key; a genuine manifest naming another business; a payload whose sha256 is not
the one the manifest signed; a schema newer than the installation; a
Local-profile install (its restores are #807's physical path). A failed import
removes the file and leaves a `failed` row with a provider-neutral code.

Honest limits, stated rather than promised away: a payload kept without its
manifest cannot be imported; a `managed_envelope_v1` payload opens only on the
installation holding that business's key generation (`backup_key_missing`
otherwise, never a partial restore); a `legacy_passphrase_v1` payload asks for its
one-time passphrase at import.

The screen says the same thing: each inventory row offers its payload and its
manifest side by side, and a «بازگردانی از فایل پشتیبان» panel below the
inventory takes them back. A successful import appears as an ordinary row, so the
preview card's typed phrase, re-authentication and MFA step-up still govern the
restore — the panel restores nothing itself.

**Validation:** 36 unit tests across the module, the three routes and the two
components; a four-case real-database suite (import after the inventory row is
gone and restore it, wrong payload for the manifest, another business's genuine
manifest, unsigned manifest); 514 backup/restore unit tests; design lint.

## Increment: membership reconciliation, and the proof of what a restore leaves alone (§5 — line closed)

The earlier "a restore must never rewind the wallet" increment wrote down three
checks it had not implemented. Two of them (`accounting_balanced`,
`sync_fence_advanced`) and the wallet assertion landed with #1210; this closes
the third and pays the proof the epic asked for.

**`membership_reconciled`.** `users.role` is the stable category, and a
composite foreign key keeps `custom_role_id` inside its own business *at write
time* — but an archive is captured table by table, so a capture that lost or
truncated `tenant_roles` still carries the users pointing at it. Those users do
not crash: they fall back to `role`'s preset, so a manager whose narrower custom
role vanished is silently authorised with the wider default. That is a
permission **escalation caused by a restore**, and it belongs in the same
transaction as the swap. The check counts active users whose custom role is
missing or inactive after the replacement and, like the others, is refused and
rolled back rather than committed. Inactive accounts are excluded on purpose —
an account that cannot sign in cannot be escalated. The check runs against a
pinned client inside the restoring transaction, so it reads the same snapshot it
just wrote.

**The proof, on a real database.** `tenant-restore-apply.integration.test.ts`
already showed another business untouched and the wallet not rewound; it now also
asserts, after an actual restore of A while B sits in the same tables:

- `wallet_ledger` and `billing_usage_events` row counts for A are **unchanged** —
  the balance is not rewound *and* the evidence explaining it still exists. The
  second matters more than it looks: `billing_usage_events.event_id` is the
  idempotency identity, so deleting it would let the next settlement re-charge a
  window this restore had "restored away";
- the **platform realm** (`platform_admins`, `platform_audit_log`) is unchanged.
  `rls_proven` refuses a privileged role at the door; this proves the other half
  — that a *permitted*, tenant-scoped role still cannot reach those rows.

The journal's `apply_succeeded` entry now lists six checks
(`rls_proven`, `owner_preserved`, `membership_reconciled`, `accounting_balanced`,
`wallet_unchanged`, `sync_fence_advanced`), all `ok`, so an auditor reading the
receipt sees what was proved rather than being told "restored".

**Still open in §5 after this:** nothing structural. What remains is the same
claim proved against a populated, production-shaped database — the integration
suite runs on a fresh one — and media/website capture, which is §8's gap rather
than §5's.

## Increment: the drift sweep, and one gate for the mirror (§1, §7)

Two behaviours were recorded here as deliberate rather than fixed, each with a
condition attached. The conditions are met without loosening either guarantee.

**1. Cloud copies are re-read on a schedule (`reverifyReadyCloudCopies`).**

A mirrored cloud copy registers `ready` on the upload's own payload hash, which is
the right moment to promote it — waiting to re-download every object before
reclaiming the local twin would either delay that reclaim or keep two copies of
every tenant's data on the app server, and §1 forbids the second. The cost was
that a mirror never enters the `verifying` queue, so nothing would notice bit rot,
a truncated object or a hand-edited bucket until a restore asked for the bytes.

The lifecycle tick now has a fourth pass. Every cloud copy that has not been read
in `REVERIFY_AFTER_MS` (a week) is re-fetched and re-verified, least recently
proved first, at most `REVERIFY_BATCH` (2) per business per tick:

- **intact** → re-marked `ready`, which refreshes `verified_at` and puts it at the
  back of the queue for another week;
- **drifted** → `failed` with the verifier's own code (`artifact_checksum_mismatch`,
  `archive_signature_invalid`, …), so the inventory stops offering it, the drill
  fails honestly, and the console can say *this copy is gone* instead of the Owner
  finding out during a restore;
- **unreachable** → left alone. A bucket outage must not mark the whole fleet
  `failed`; the next tick retries;
- **inside its retention window** → skipped, because `expireDueArtifacts` is about
  to delete it and downloading it first buys nothing.

A week is a deliberate trade: the sweep downloads the whole object again, so its
value is in being cheap enough to keep forever, not in being frequent. It reuses
the existing verifier and adds no new state — `verified_at` already existed and
was already what "proved" meant.

**2. The mirror follows the destination, not the tenant's old switch
(`managedMirrorDestination`).**

`tickBusiness` took the backup when `config.enabled || managedSchedule` but
uploaded it only when `config.cloud.enabled` was set — a tenant-era boolean the
owner decision removed from the tenant's reach. On a managed Cloud business whose
legacy field was never set, the backup was taken locally and mirrored a tick
later, so for one interval the platform held the only copy of that business's
data on its own disk — the shape §1 exists to prevent.

The mirror now runs when the *resolved destination* is the platform's managed
storage: the profile is read server-side, and `resolveTenantStorage` answers
`unavailable` for a Local installation before it looks at anything else. A Local
business therefore still makes no outbound call no matter what the fleet row or
the legacy flag says, and the acceptance suite asserts exactly that in the same
tick that proves the Cloud mirror now happens immediately.

**Validation.** Unit: `reverifyReadyCloudCopies` ×8 (due/not-due/never-proved,
drift → `failed` with the verifier's code, provider outage leaves the row, batch
bound plus least-recently-proved ordering, retention skip, local rows untouched)
and the lifecycle suite at 33. Integration, on PostgreSQL 18 with the RLS app role
and a path-style S3 stand-in that can be made to store damaged bytes: bit rot on a
`ready` copy is caught by the sweep (state `failed`, `artifact_checksum_mismatch`,
drill fails) and a managed Cloud backup now mirrors inside the same
`runTenantSnapshotTick()` while the Local business in that tick still receives no
cloud row — the acceptance suite is 12/12.

## Where #903 stands (2026-11-05)

Every P0 and P1 line of the epic's §10 checklist is implemented and verified
except **media binary capture**, which is a design decision rather than a task —
see [`media-binary-capture.md`](./media-binary-capture.md).

What that means concretely, in the shipped runtime:

- a business on all three profiles is backed up, verified, billed, drilled and
  restorable, and a central logical restore changes only the target business
  (proved on a real database, including the platform realm and the canonical
  wallet);
- a Cloud copy that rots is caught by the weekly drift sweep instead of by a
  restore;
- a file the platform never wrote can be imported against its signed manifest and
  restored through the same preview/apply path;
- media **rows** are captured and labelled, media **bytes** are `excluded`, and no
  screen or API claims otherwise.

What is still outstanding is verification against production shapes rather than a
fresh database: a real S3 provider round-trip, a drill on a populated
production-sized dataset, and the desktop packaging path. CI covers
`npm run build` and the visual suite; the provider round-trip is deliberately out
of reach of a sandbox with a path-style stand-in.
