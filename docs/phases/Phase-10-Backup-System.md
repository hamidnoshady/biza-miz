# Phase 10 — Backup System (Local + Cloud)

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0–9
**Goal:** Every location's data is recoverable from both a local backup and an offsite cloud backup, without depending on the multi-location central DB (Phase 9) as the only copy.

---

## Scope

- **Local backup** — scheduled `pg_dump` (or equivalent) of each location's local Postgres instance to local disk (and ideally a second local target — e.g. attached USB drive or NAS if present), on a rolling retention schedule
- **Cloud backup** — encrypted upload of the same backup artifact to offsite cloud storage (e.g. S3-compatible), scheduled independently of LAN-only operation — this is one of the few things allowed to require internet, per the hard rule that internet is only for ZarinPal/cloud backup/cross-location sync
- Backup schedule configuration (frequency, retention count/duration) — likely Owner-only setting
- Manual "backup now" trigger from the Owner/Manager dashboard
- Restore flow: documented and tested procedure to restore a location's DB from either local or cloud backup artifact, including a dry-run/verify step (restore to a scratch DB and validate before overwriting production)
- Backup health monitoring: last successful backup timestamp visible on the dashboard, alert if a scheduled backup fails or hasn't run within an expected window
- Encryption at rest for cloud-stored backups (backups contain full financial ledger + customer data — reservations, delivery addresses once Phase 11 ships)
- Backup coverage for the Phase 9 central aggregation DB, not just per-location DBs

## Out of scope

- Point-in-time recovery / continuous WAL archiving (this phase is scheduled full-backup based, not PITR — flag as a future enhancement if needed)
- Cross-location disaster recovery orchestration beyond "restore this one location's DB"

## Exit criteria

- A scheduled local backup runs automatically and produces a restorable artifact
- A scheduled cloud backup runs automatically, uploads successfully, and the artifact is encrypted at rest
- Restoring a test location's DB from a local backup artifact succeeds and produces correct data
- Restoring the same from a cloud backup artifact succeeds and produces correct data
- Deliberately failing a scheduled backup (e.g. disconnect network) surfaces an alert on the Owner dashboard within the expected window
- Central aggregation DB (Phase 9) has its own backup schedule covered
- Restore procedure is documented step-by-step, not just working in principle

---

## Questions to answer before/during this phase

1. **Cloud provider** — do you have a preferred provider/account already (AWS S3, Backblaze B2, etc.), or should Claude Code propose one? This affects cost and setup specifics.
2. **Backup frequency** — how often should backups run (e.g. hourly, end-of-shift, nightly), and how much data loss is acceptable in a worst-case restore (this sets your RPO)?
3. **Retention policy** — how many backups to keep and for how long (e.g. 7 daily + 4 weekly + 12 monthly), balancing storage cost vs. recovery flexibility?
4. **Local secondary target** — is there an on-site NAS or external drive to back up to locally, or is local backup just "another folder on the same mini PC" (weaker, but still better than nothing)?
5. **Encryption key management** — who holds the encryption key/passphrase for cloud backups — stored where, and who has access if a restore is needed and the primary Owner is unavailable?
6. **Alert channel** — should a failed/missed backup alert go to the Owner dashboard only, or also email/SMS, given this is the kind of failure that's easy to miss if no one's looking at the dashboard?

---

## Decisions on Phase 10 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Cloud provider** — **no provider is hard-wired: any S3-compatible endpoint works.** The Owner enters endpoint/region/bucket/keys on `/dashboard/backup`; the client (`src/lib/s3-lite.ts`, hand-rolled SigV4 verified byte-for-byte against botocore's S3 signer, path-style URLs) was built for compatibility, not one vendor. For an Iranian café the practical default is **ArvanCloud object storage** (S3-compatible, domestic — reachable and payable from inside Iran); Backblaze B2/AWS S3/a LAN MinIO on a NAS all work with the same four fields. No SDK dependency was added.
2. **Backup frequency / RPO** — **default nightly at 03:30 local time** (after close of business — one business day is the accepted worst-case loss for a café), Owner-configurable from hourly to daily (`intervalHours` ∈ {1,2,3,4,6,8,12,24} anchored on a wall-clock time, computed in the location's own timezone — `isBackupDue`, `src/lib/backup.ts`). "End-of-shift" isn't a schedulable event because there's still no shift entity (Phase 8 decision); the anchor time covers the "after we close" intent, and «پشتیبان‌گیری هم‌اکنون» covers ad-hoc.
3. **Retention policy** — **simple keep-newest-N, not grandfather-father-son: 14 local / 30 cloud by default** (each 1–365, Owner-set). A café restore is essentially always "the newest artifact"; tiered monthly archives add bookkeeping without a real recovery scenario at this scale. Pruning (`selectPrunable`) only ever deletes files matching the artifact pattern — a stray file in the backup folder is never touched.
4. **Local secondary target** — **supported but machine-config, not dashboard-config**: set `BACKUP_SECONDARY_DIR` (mounted USB/NAS path) in `.env` and every artifact is copied there too. Deliberate hard line: a failed secondary copy **fails the run** and raises the dashboard alert — an unplugged drive that silently degrades to "one copy on the same disk" is precisely the failure this phase exists to catch. Without the env var, local backup is `BACKUP_DIR` (default `./backups`) on the mini PC — weaker, and the cloud copy is the real answer there.
5. **Encryption key management** — **an Owner-chosen passphrase (min 8 chars), stored in the local DB settings so the scheduler can encrypt unattended; never sent to or stored with the cloud provider** (artifacts are AES-256-GCM, key scrypt-derived per artifact — `encryptBackup`, `src/lib/backup.ts`). The runbook (docs/deployment/backup-restore.md, "Key management") instructs keeping the passphrase + S3 credentials in the Owner's password manager **and** on paper in a sealed envelope with the business's critical documents — that envelope is the answer to "primary Owner unavailable", and after a total machine loss (settings die with the DB) it's the only copy. Losing it makes cloud artifacts unrecoverable by design; local artifacts stay plaintext on-site so an on-site restore never depends on remembering anything.
6. **Alert channel** — **Owner dashboard only, matching Phase 9's staleness-flag precedent** — no email/SMS/push channel exists anywhere in the system yet and this phase didn't build one (flagged as a future enhancement; the health model already computes a single `BackupAlert` that a future channel can forward). Mitigations for "nobody's looking": the alert is a red banner on the **main** dashboard (the screen someone opens daily to see sales), not just on the backup page; it fires within interval + grace (nightly ⇒ 30h, `backupStaleAfterMs`); and a still-disabled backup config shows the Owner an amber "backups not enabled" nudge once setup is complete.

**Other decisions made while building:**

- **The artifact is the whole database, not per-business slices** — `pg_dump --format=custom` of everything (compressed, checksummed, `pg_restore`-able). v1 is one business per install; run history/config are still keyed per business like every other setting.
- **Cloud upload is decoupled from the dump** — a backup taken while offline records a failed/absent cloud run, and every scheduler tick (60s) re-nudges the newest not-yet-uploaded artifact with a 10-minute retry backoff (`maybeCatchUpCloud`). LAN-only operation is never blocked by the upload; this is the same "internet only delays, never breaks" stance as Phase 9 sync.
- **Schedule slots are wall-clock, not instants** — "03:30 nightly" means 03:30 Tehran wall time regardless of UTC offset arithmetic; due-ness compares the last run's wall time against the latest slot (`latestSlotBefore`), so a missed slot (machine off overnight) triggers exactly one catch-up backup on boot, not a burst.
- **Secrets are write-only through the API** — `GET /api/backup/config` masks the S3 secret and passphrase to `hasSecretAccessKey`/`hasPassphrase` flags; an empty field on save keeps the stored value. Access split: config is Owner-only, "backup now"/status are Owner+Manager (enforced in `api-guards.test.ts` alongside the Phase 9 rules).
- **Restore tooling always dry-runs first** — `scripts/restore.ts` restores into `<db>_restore_verify` and validates (migration list, core-table row counts) before `--apply --yes` will touch production; `--from-cloud` reads credentials from env because after a machine loss there is no DB to read settings from.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Scheduled local backup runs automatically, artifact restorable | `runBackupTick` (`src/lib/backup-service.ts`, timer in `server.ts`, 60s) + `isBackupDue` slot logic (`src/lib/backup.ts`, unit-tested incl. Tehran wall-clock cases); verified end-to-end on a live Postgres 16: enabled config → tick produces `pos-backup-….dump` in `backups/`, `backup_runs` row `success`, second tick correctly does nothing; artifact then restored (next row) |
| Scheduled cloud backup uploads, encrypted at rest | `runCloudUpload` — artifact encrypted (`encryptBackup`) then PUT via SigV4 (`s3-lite.ts`); verified against an S3-compatible test server: stored object carries the `POSBKP1` magic (ciphertext, not a dump), decrypts back to a byte-identical `PGDMP` file with the passphrase, and cloud retention pruned to N; upload-after-offline retry exercised via the tick's catch-up path |
| Restore from local artifact produces correct data | `npm run db:restore -- backups/<artifact>` dry-run validated (10 migrations, correct row counts), then `--apply --yes`: a marker row inserted *after* the backup was gone post-restore and pre-backup data intact |
| Restore from cloud artifact produces correct data | Same flow with `--from-cloud <key>` + `BACKUP_S3_*`/`BACKUP_PASSPHRASE` env: downloaded, decrypted, scratch-verified identically (verified end-to-end against the test server) |
| Deliberately failed backup alerts on the Owner dashboard within the window | Verified both failure modes: unreachable cloud endpoint → `cloud_failed`, broken `pg_dump` → `local_failed` — each surfacing as the red banner on `/dashboard` (`computeBackupAlert`; "hasn't run within expected window" = `backupStaleAfterMs`, interval + ≥1h grace, unit-tested) |
| Central aggregation DB covered | Central is another deployment of this app (Phase 9 decision), so migration `0010_backup.sql`, the scheduler, and `/dashboard/backup` exist there identically — enable backups on the central instance's own dashboard; nothing location-specific is assumed by the pipeline |
| Restore procedure documented step-by-step | `docs/deployment/backup-restore.md` — local, cloud, and bare-metal-recovery runbooks plus key-management instructions; every step is the tested `scripts/restore.ts` path, not prose-only |

Schema: `migrations/0010_backup.sql` (`backup_runs`). Logic: `src/lib/backup.ts` (pure — schedule, retention, alerting, encryption; unit-tested) + `src/lib/s3-lite.ts` (pure SigV4 + fetch ops; unit-tested against botocore-verified signatures) + `src/lib/backup-service.ts` (pg_dump/fs/DB/network). Routes: `src/app/api/backup/{config,run,status}`. UI: `/dashboard/backup` (`backup-manager.tsx`) + alert banners on `/dashboard`. Scheduler: `server.ts`. Restore: `scripts/restore.ts` (`npm run db:restore`) + `docs/deployment/backup-restore.md`.
