# Backup & Restore Runbook (Phase 10)

How backups work, and — step by step — how to restore a location's database
from a local or cloud artifact. Every procedure here is also automated by
`scripts/restore.ts` (`npm run db:restore`), which always dry-runs into a
scratch database before anything destructive.

## What a backup is

- A **`pg_dump --format=custom`** of the **whole local PostgreSQL database**
  (all phases, all tables — orders, ledger, inventory, reservations,
  settings, …). One artifact per run, named
  `pos-backup-YYYYMMDD-HHMMSS.dump` (UTC stamp, sorts chronologically).
- **Local**: written to the destination folder the Owner sets on
  `/dashboard/backup`, falling back to `BACKUP_DIR` (default `./backups` next
  to the app) when that is left empty — which it is on every install that
  predates the standalone desktop app, so nothing moved. If
  `BACKUP_SECONDARY_DIR` is set (mounted USB drive / NAS), each artifact
  is also copied there — and a failed copy fails the run, so an unplugged
  drive raises the dashboard alert instead of silently degrading.
- **Cloud**: the same artifact, **encrypted** with the Owner's passphrase
  (AES-256-GCM, scrypt key derivation), uploaded as
  `<prefix>pos-backup-….dump.enc` to any S3-compatible storage (ArvanCloud,
  AWS S3, Backblaze B2, a MinIO on a NAS, …).
  
  **IMPORTANT**: Since Phase 24, local and USB artifacts are ALSO encrypted 
  with this passphrase by default. The provider only ever holds
  ciphertext. Uploads that fail (no internet at backup time) are retried
  automatically until a newer artifact supersedes them. A standalone desktop
  install (`deployment.mode = local`) has no cloud half — the dashboard hides
  the section and the API refuses to enable it, so only the local bullet above
  applies there.
- **Schedule/retention** are configured by the Owner on
  `/dashboard/backup`; artifacts beyond the retention count are pruned
  automatically on both sides. Run history is in the `backup_runs` table and
  on the dashboard; a failed or overdue backup shows a red alert on the main
  Owner dashboard within one interval + grace (nightly ⇒ within 30h).
- **Which database connection it uses:** `BACKUP_DATABASE_URL`, falling back to
  `DATABASE_URL`. This is deliberately *not* the connection the app serves
  requests with: since Phase 12 the server runs as the restricted `pos_app`
  role so row-level security applies to it, and `pg_dump` cannot dump a
  RLS-forced table as such a role — it aborts on the first table with
  `query would be affected by row-level security policy for table "accounts"`.
  Docker's entrypoint and the desktop launcher both keep the privileged
  (migrating/owner) connection in `BACKUP_DATABASE_URL` for this, so nothing
  needs configuring; set it by hand only where `DATABASE_URL` itself isn't
  privileged (e.g. managed Postgres with a hand-provisioned `pos_app`). If a
  run fails with that error, this variable is what's wrong.
- The Phase 9 **central aggregation server is just another deployment of
  this app**, so it gets the exact same backup system — enable it on the
  central instance's own dashboard too.

## Key management (read this before you need it)

Local, USB, and cloud artifacts are ALL unrecoverable without the encryption passphrase. Keep it:

1. In the Owner's password manager, **and**
2. On paper (sealed envelope) wherever the business keeps its other
   critical documents — so a restore is possible even if the primary Owner
   is unreachable.

The S3 credentials should likewise be stored outside the POS machine — after
a total machine loss, the dashboard settings (which live in the database) are
gone with it; restore then needs the passphrase + S3 credentials from that
envelope/password manager.

## Restore, step by step

Prerequisites: a machine with this repo, Node ≥ 20, `pg_restore`
(postgresql-client 16+), and a running PostgreSQL 16 server (the
docker-compose one is fine). `DATABASE_URL` in `.env` must point at the
target server.

### A. From a local artifact

```bash
# 1. Dry run — restores into a scratch DB (pos_restore_verify) and
#    validates; the production DB is NOT touched:
npm run db:restore -- backups/pos-backup-20260721-033001.dump

# 2. Read the validation output (migration count, row counts for
#    businesses/locations/users/orders/journal_entries). If it looks right:

# 3. Stop the app (the restore terminates open DB connections), then:
npm run db:restore -- backups/pos-backup-20260721-033001.dump --apply --yes

# 4. Start the app, log in, and spot-check: today's orders list, ledger
#    trial balance, inventory levels.
```

`--apply` re-verifies into the scratch DB first and only then drops and
recreates the production database from the artifact. `--yes` is required —
there is no interactive prompt to fat-finger.

### B. From a cloud artifact

```bash
# 1. Credentials + passphrase come from env (no DB to read settings from):
export BACKUP_S3_ENDPOINT=https://s3.ir-thr-at1.arvanstorage.ir
export BACKUP_S3_BUCKET=my-cafe-backups
export BACKUP_S3_ACCESS_KEY_ID=…
export BACKUP_S3_SECRET_ACCESS_KEY=…
export BACKUP_PASSPHRASE='the passphrase from the sealed envelope'

# 2. Dry run (downloads, decrypts, scratch-verifies):
npm run db:restore -- --from-cloud pos-backups/pos-backup-20260721-033001.dump.enc

# 3. Apply, same as the local flow:
npm run db:restore -- --from-cloud pos-backups/pos-backup-20260721-033001.dump.enc --apply --yes
```

Don't know the newest key? Any S3 browser works, or take the newest
`cloud_key` from the dashboard's run history (if the machine still lives).

You can also restore a manually-downloaded `.dump.enc` as a local file —
`isEncryptedBackup` detection is automatic; only `BACKUP_PASSPHRASE` is
needed.

### A2. From a backup file, in the app (reinstall, USB stick)

The dashboard's artifact list comes from this database's own `backup_runs`, so
a freshly installed or reinstalled desktop lists nothing — even with the old
`.dump`/`.dump.enc` sitting in the backup folder. Two in-app paths take the
file itself:

- **First-run screen** (`/welcome`, third choice «بازگردانی از فایل پشتیبان»):
  offered only on a *site* install whose database has no business and no user
  (`freshInstallRestoreAvailable()`), the same window bootstrap and pairing run
  in. Never on a central server.
- **`/dashboard/backup` → بازگردانی پشتیبان → «از فایل»**: Owner-only, on a
  single-business install, like the listed artifacts.

Either way the file is uploaded in ≤ 4 MB pieces (`src/lib/restore-upload.ts`
— Next's middleware truncates any request body over 10 MB), verified into the
scratch database, and applied only after an explicit confirmation. An
encrypted file needs the passphrase of the install that wrote it, typed into
the form. Only `.dump`/`.dump.enc` restore; the SQL/xlsx *export* is a
per-business data export, not a restorable backup.

After applying: restart the app (the desktop runs pending migrations at start,
so an older backup is brought up to date), sign in with the accounts inside
the backup, and re-attach cloud sync from «تنظیمات ← اتصال‌ها ← برنامهٔ دسکتاپ ←
ترمیم / اتصال دوباره» with a fresh pairing code. Repair keeps the restored data
and its queued sync events, so what never reached the cloud before the
reinstall is sent after it.

### C. Bare-metal recovery (machine completely lost)

1. New machine: install Docker + Node, clone this repo, `npm install`,
   `docker compose up -d`, `cp .env.example .env`.
2. Do **not** run migrations or the seed — the restore brings the whole
   schema and data.
3. Follow **B** (cloud restore). The scratch database is created on the
   fresh server automatically; `--apply --yes` then creates the production
   database from the artifact.
4. Start the app (`npm run dev` / `npm start`), log in with the same
   credentials as before (they're in the backup), re-check
   `/dashboard/backup` — schedule/cloud settings restored with everything
   else; take a fresh manual backup to prove the new machine can.

Moving a *live* install to a new server (rather than recovering a lost one) is
the same restore with a drain/verify/cutover procedure around it, and differs
per hosting platform — see
[docs/server-migration.md](server-migration.md).

### Notes

- **What a restore loses:** everything after the artifact's timestamp — the
  schedule (default nightly) bounds the worst case; raise the frequency on
  `/dashboard/backup` if a day is too much (see the phase doc's RPO
  decision).
- The scratch database is dropped automatically after verification
  (`--keep-scratch` keeps it for inspection).
- A restore is all-or-nothing per database: there is no partial/table-level
  restore in this phase, and no point-in-time recovery (full-backup based,
  PITR flagged as a future enhancement).
- Version rule: run `pg_restore` of the **same or newer** major version as
  the PostgreSQL server that produced the dump (both are 16 here).

## Whole-system (platform) backup, and restoring by address (migration 0132)

Everything above is what an **Owner** does for **their business**. The super-admin
console has a second, independent half for the **deployment**: «پشتیبان‌گیری» under
`/platform/backup`, backed by `src/lib/platform-backup-service.ts`.

It is not the same feature with more buttons. A per-business backup is one
tenant's rows; this is one `pg_dump` of the **entire database** — every business,
the platform's own tables (admins, billing, AI gateway config), and the schema —
plus the two things the console needs to hand that file to another machine:

| | Owner `/dashboard/backup` | Console `/platform/backup` |
|---|---|---|
| What it copies | one business's rows (export) / this database (dump) | this database, whole |
| Schedule owner | the business | the deployment |
| Artifact folder | `BACKUP_DIR` | `PLATFORM_BACKUP_DIR`, default `BACKUP_DIR/platform` |
| Retention prunes | its own folder only | its own folder only |
| Can be pulled by another server | no | yes — `/api/peer/backup/*`, off until you switch it on |
| Who can restore | an Owner, their business | owner-role admin, this whole install |

The two folders are separate namespaces **on purpose**: both name artifacts
`pos-backup-YYYYMMDD-HHMMSS.dump`, so sharing one flat directory would let either
side's retention delete the other's copies.

### Turning it on

Settings live in `platform_backup_config` (one row) and are written from the
console; the `PLATFORM_BACKUP_*` variables in `.env.example` are defaults for the
cases where the console is unreachable. Nothing runs until `enabled` is on —
there is no silent nightly job on a fresh install.

The console runs it the same way the Owner dashboard does: `pg_dump` as
`BACKUP_DATABASE_URL` (the privileged connection — as `pos_app`, RLS makes
pg_dump abort), optional AES-256-GCM encryption with the platform passphrase,
`fsync` + rename + directory `fsync`, then the same in
`PLATFORM_BACKUP_SECONDARY_DIR` when set, then retention. Each run writes a
`<artifact>.manifest.json` sidecar describing what the file contains: app version,
migration count, Postgres major, business count, size and sha256.

The server also checks that schedule itself — `runPlatformBackupTick()` runs from
`server.ts` on the same 60-second heartbeat as the per-business tick, taking a copy
only when the configured interval has elapsed — so a process that stays up needs no
cron entry. An operator can force one from the page at any time; the two paths share
one in-flight guard (`backupInFlight` in the service), so a manual click during a
scheduled run answers 409 `backup_busy` — nothing is queued and the database is
never dumped twice at once.

### Giving another server the address

Two switches and a key, all in «دسترسی سرور دیگر به این نسخه‌ها»:

1. `servingEnabled` — until it is on, `/api/peer/backup/manifest` and
   `/api/peer/backup/download` answer 404, indistinguishable from "no such route".
2. A **token** — created on that page, shown once, stored only as a sha256. The
   peer sends it as `Authorization: Bearer …`.
3. `allowInsecurePeers` — off; when off, peer addresses must be `https://`. Private
   LAN addresses are allowed either way (a NAS/MinIO on the same network is the
   normal case), but only over TLS unless you say otherwise.

That channel serves exactly two things: the manifest, and one artifact by name.
There is no write path, no listing of anything else, and no path traversal — a
requested name that isn't `pos-backup-<stamp>.dump[.enc]` is a 404.

### Restoring on the new server

On the *new* install's same page, «بازیابی از آدرس»:

1. **Add the peer** — a label, the old server's URL, and the token it issued.
2. **بررسی اتصال** — fetches the manifest and compares it with this install: the
   old server's migration count and Postgres major versus ours. A newer schema
   there is a refusal here (`newer_schema`) — restoring it would put a database
   this build's queries don't have in front of them.
3. **اعتبارسنجی** — downloads the artifact (capped while streaming by
   `PLATFORM_BACKUP_MAX_DOWNLOAD_BYTES`, sha256 computed on the bytes actually
   received), decrypts it if needed, restores it into a scratch database
   `<name>_restore_verify`, counts the rows, and drops the scratch. **Nothing on
   this server changes.**
4. **بازگردانی کامل** — the same file restored over the live database: drop and
   recreate, `pg_restore`, re-grant `pos_app`. Requires typing a confirmation
   phrase and the `backup.restore` capability, which the **owner** role alone
   holds.

Both the verify step and the apply step are recorded in `platform_restore_runs`,
so a failed attempt is visible in the console with its error.

Two things to know before step 4:

- **The restore replaces the console's own settings too** — `platform_backup_config`,
  admins, tokens and peers all come from the old server afterwards, because they
  live in the database being replaced. That is intended for a migration, and
  surprising for a "just the data please". Restart the app after applying, so every
  pool and cache is rebuilt on the new database.
- **Restore needs the passphrase**, if the source encrypted. Either this install
  already has it (settings), or you type it for that one attempt — it is never
  stored.

For a *lost* machine (no old server to pull from) use the folder plus
`npm run db:restore` as in §A/§B above; the sidecar manifests in the platform
folder are what tell you which artifact matches this build. Moving a live install
with a drain/verify/cutover around this is
[docs/server-migration.md](server-migration.md).

## Per-tenant export & restore (Phase 17)

Everything above is a whole-database artifact — every business hosted on
that install. A single business's *own* data is a separate, smaller thing:
an Owner can download it from `/dashboard/backup` (**«خروجی اطلاعات
کسب‌وکار»**), either as a restorable SQL file or a per-table Excel workbook.
`scripts/restore-tenant.ts` (`npm run db:restore-tenant`) is the SQL file's
restore tool.

Unlike the whole-database restore, this is plain SQL (`INSERT` statements,
no schema) meant for **an already-migrated, otherwise-empty database** — the
literal Phase 17 exit criterion is restoring "into a clean database without
carrying any other tenant's rows." It is not a merge/upsert tool: restoring
into a database that already has this business (or one of its rows) fails
with a clear error rather than silently overwriting or duplicating anything.

```bash
# 1. Get the export from an Owner's /dashboard/backup, or directly:
curl -b <session-cookie> "https://your-install/api/backup/export?format=sql" -o business.sql

# 2. Migrate the target database first (schema only, no data):
DATABASE_URL=postgres://…/new_db npm run db:migrate

# 3. Dry run — every INSERT actually runs, then rolls back; the target is
#    NOT changed. Any conflict (this business already exists there) surfaces
#    here, before anything is committed:
npm run db:restore-tenant -- business.sql --database-url postgres://…/new_db

# 4. Apply for real:
npm run db:restore-tenant -- business.sql --database-url postgres://…/new_db --apply --yes
```

Notes:

- No scratch database is needed for the dry run — since this is ordinary
  `INSERT` statements rather than a physical `pg_restore`, the tool wraps
  them in a transaction and rolls back instead of committing, which proves
  the same thing (every constraint the real restore would hit) without a
  second database.
- The export SQL itself sets `session_replication_role = replica` for the
  duration of its transaction, so restoring doesn't re-trigger business-rule
  triggers meant for live mutations (e.g. "an order's items can't change once
  it's no longer open") against historical rows that already passed through
  them once, before export.
- This restores exactly the rows that were exported — it does not, by
  itself, migrate a schema. Always `npm run db:migrate` the target first.
