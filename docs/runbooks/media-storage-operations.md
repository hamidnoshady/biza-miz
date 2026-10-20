# Media Storage Operations Runbook

Operational guide for the platform-wide S3-compatible Media Library (`/platform/media` and `/media`).

## 1. Architecture & Isolation Invariants

1. **Single deployment bucket, strict per-tenant prefix isolation:**
   - Every stored object key follows `{keyPrefix}{businessId}/{assetId}/{safeFileName}`.
   - All tenant rows in `media_assets`, `media_folders`, `media_collections`, `item_media`, and `wordpress_media_mapping` enforce PostgreSQL Row-Level Security (`FORCE ROW LEVEL SECURITY`) plus composite tenant foreign keys (`(business_id, folder_id)` and `(business_id, source_asset_id)`).
   - Every read, stream, presign, and delete path re-validates `keyBelongsToBusiness(storageKey, keyPrefix, businessId)` fail-closed before touching object storage.
2. **Soft-delete & audit protection:**
   - Standard deletion stamps `media_assets.deleted_at = now()`, immediately invalidates local hybrid mirrors (`.data/media-mirror`), and propagates via continuous HLC master sync (`media_assets` table) so paired sites never re-expose trashed assets on reconnect.
   - Assets referenced by protected records — controlled Workspace documents (`in_review`, `approved`, `archived`), versioned chains (`version > 1` or superseded), contract attachments (`workspace_contracts`), journal attachments, AEC drawings/revisions/registers, or posted `financial_transfers` — return `409 asset_protected` and are **never** deleted by `?force=1`, `?purge=1`, or `runMediaTrashPurgeTick`.

---

## 2. Changing Object Storage Location Safely (`endpoint`, `bucket`, `keyPrefix`)

Direct overwrites of `endpoint`, `bucket`, or `keyPrefix` via `PUT /api/platform/media` are **blocked with HTTP `409 storage_migration_required`** whenever `media_assets` contains one or more rows.

### Safe Migration Procedure (`/platform/media` or `POST /api/platform/media/migrate`)
1. Prepare the destination bucket with versioning/backups enabled and generate dedicated least-privilege S3 credentials.
2. Open **Superadmin Console → رسانه (`/platform/media`)**, enter the new `endpoint`, `bucket`, `keyPrefix`, `accessKeyId`, and `secretAccessKey`, and click **تست اتصال (Test Connection)**.
3. Click **اجرای مهاجرت امن و تأیید SHA-256** (`POST /api/platform/media/migrate` with `{ mode: "migrate", ... }`). The platform executes:
   - Connectivity write/read/delete probe on the target bucket;
   - Full object copy for all active and trashed `media_assets` rows without deleting source objects;
   - Independent read-back verification checking **object count**, **exact `byte_size`**, and **cryptographic `sha256`** on every copied object;
   - Atomic database switch storing the old credentials in `platform_media_config.previous_*` for transparent **dual-read fallback** and one-click rollback;
   - Redacted audit trail entry in `platform_media_migrations`.
4. **Post-migration cooling period:** Leave the source bucket intact for at least one full backup cycle (recommended: 7–14 days) before retiring old credentials or objects.

### Emergency Rollback
If downstream issues appear after cutover while the source bucket still holds verified objects:
- Trigger **بازگشت به فضای ذخیره‌سازی قبلی** in `/platform/media` (`POST /api/platform/media/migrate` with `{ mode: "rollback" }`).
- The service re-verifies every `media_assets` row against `previous_*` storage before switching `platform_media_config` and `storage_key` prefixes atomically back to the previous bucket.

---

## 3. Orphan Reconciliation & Storage Cleanup

### Automated Read-Only Monitoring
- `server.ts` runs `runMediaOrphanReconcileTick` every 6 hours on central deployments (`apply: false` strictly read-only) and records findings in `platform_media_orphan_scans`.
- Any unreferenced object older than the **1-hour grace window** sets scan status to `alert` in `/platform/media` without deleting anything automatically.
- Objects whose keys do not conform to `{keyPrefix}{businessUuid}/{assetUuid}/{file}` are counted under `prefixSkipped` and **never** deleted automatically.

### Manual Verified Cleanup
1. Take and verify both a **PostgreSQL database backup** and an **S3 bucket backup / snapshot**.
2. Inspect the dry-run report first:
   ```bash
   npx tsx scripts/media-reconcile-orphans.ts
   ```
3. Confirm `Broken references: 0` (every `media_assets` row resolves to a live object in S3). If broken references are non-zero, restore missing objects from S3 backup/versioning **before** running cleanup.
4. Execute gated cleanup either from `/platform/media` (checking explicit backup confirmation) or via CLI:
   ```bash
   npx tsx scripts/media-reconcile-orphans.ts --apply --backup-confirmed
   ```
