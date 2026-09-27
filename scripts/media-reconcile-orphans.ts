/**
 * Media Library storage orphan reconciliation.
 *
 * Two failure modes leave the bucket and the `media_assets` table out of
 * sync, both already possible today given how storeMediaAsset/deleteMediaAsset
 * are written (see src/lib/media-service.ts):
 *
 *   1. storeMediaAsset() does `s3Put` THEN `INSERT`. A crash, OOM, or lost
 *      connection between those two lines leaves an object in the bucket
 *      that no row was ever created for.
 *   2. deleteMediaAsset() does `DELETE ... RETURNING storage_key` THEN
 *      `s3Delete`, and DELIBERATELY swallows the s3Delete failure ("the row
 *      is gone, so the asset is gone for every user; a stranded object costs
 *      storage until the operator prunes, never data exposure" — see the
 *      comment at its call site). A transient network error there leaves
 *      exactly the orphan this script exists to find and remove.
 *
 * This script never touches a `media_assets` row. It only ever deletes
 * bucket objects that no row (including soft-deleted/trashed rows, which
 * still legitimately own their object until the retention purge) points at.
 * The inverse finding — a row whose storage_key does not resolve to any
 * object in the bucket — is reported as a "broken reference" for a human to
 * investigate; deleting *that* row is a data-loss decision this script does
 * not make for you.
 *
 * Default is read-only (dry run). Deleting orphaned objects requires
 * --apply AND --backup-confirmed, the same two-gate convention as
 * reconcile-opening-inventory.ts.
 *
 * Usage:
 *   npx tsx scripts/media-reconcile-orphans.ts                       # dry run, every business
 *   npx tsx scripts/media-reconcile-orphans.ts --business=<uuid>      # dry run, one business's prefix only
 *   npx tsx scripts/media-reconcile-orphans.ts --apply --backup-confirmed
 *
 * Note: the function body is wrapped in an async main() rather than using
 * top-level await — this repo's root package.json declares "type":
 * "commonjs", under which tsx's esbuild transform rejects top-level await
 * (confirmed against the pre-existing scripts/reconcile-opening-inventory.ts,
 * which has the same limitation and fails the same way if invoked directly).
 */
import "dotenv/config";
import { Client } from "pg";
import { s3Delete, s3List, type S3Config } from "../src/lib/s3-lite";
import { keyBelongsToBusiness, normalizeKeyPrefix } from "../src/lib/media";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const backupConfirmed = process.argv.includes("--backup-confirmed");
  const businessArg = process.argv.find((a) => a.startsWith("--business="))?.split("=")[1] ?? null;
  /**
   * An object created less than this long ago is never treated as an orphan,
   * even if no row currently points at it — it may simply be a
   * storeMediaAsset() call that has put its bytes but not yet committed its
   * INSERT while this script happens to be running concurrently with live
   * traffic.
   */
  const GRACE_PERIOD_MS = 60 * 60 * 1000; // 1 hour

  if (apply && !backupConfirmed) {
    console.error("Refusing --apply: take and verify a storage/database backup, then pass --backup-confirmed.");
    return 2;
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // The documented RLS escape hatch (migrations/0021), same mechanism as
    // withoutTenantScope() in src/lib/db.ts: a maintenance script legitimately
    // needs to see every business's rows, not one tenant's.
    await client.query(`SELECT set_config('app.rls_bypass', 'on', false)`);

    const { rows: configRows } = await client.query<{
      enabled: boolean;
      endpoint: string;
      region: string;
      bucket: string;
      key_prefix: string;
      access_key_id: string;
      secret_access_key: string;
    }>(`SELECT enabled, endpoint, region, bucket, key_prefix, access_key_id, secret_access_key
          FROM platform_media_config WHERE id = true`);
    const cfg = configRows[0];
    if (!cfg || !cfg.enabled || !cfg.bucket || !cfg.endpoint) {
      console.log("Media storage is not configured/enabled — nothing to reconcile.");
      return 0;
    }
    const prefix = normalizeKeyPrefix(cfg.key_prefix);
    const s3Config: S3Config = {
      endpoint: cfg.endpoint,
      region: cfg.region,
      bucket: cfg.bucket,
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
    };

    const listPrefix = businessArg ? `${prefix}${businessArg}/` : prefix;
    console.log(`Listing bucket objects under "${listPrefix}" …`);
    const objects = await s3List(s3Config, listPrefix);
    console.log(`${objects.length} object(s) in the bucket under that prefix.`);

    const rowFilter = businessArg
      ? { sql: `WHERE business_id = $1`, params: [businessArg] }
      : { sql: ``, params: [] as string[] };
    // Every row, trashed or not — a trashed asset still owns its object until
    // the retention purge (migrations/0174), so its key must count as "claimed".
    const { rows: assetRows } = await client.query<{ id: string; business_id: string; storage_key: string }>(
      `SELECT id, business_id, storage_key FROM media_assets ${rowFilter.sql}`,
      rowFilter.params,
    );
    const claimedKeys = new Set(assetRows.map((r) => r.storage_key));

    const now = Date.now();
    const candidates = objects.filter((o) => {
      if (claimedKeys.has(o.key)) return false;
      const modified = Date.parse(o.lastModified);
      if (Number.isFinite(modified) && now - modified < GRACE_PERIOD_MS) return false; // too fresh to judge
      return true;
    });
    const malformed = candidates.filter(
      (o) => !keyBelongsToBusiness(o.key, prefix, o.key.slice(prefix.length).split("/")[0] ?? ""),
    );
    const malformedKeys = new Set(malformed.map((o) => o.key));
    const safeOrphans = candidates.filter((o) => !malformedKeys.has(o.key));

    const bucketKeys = new Set(objects.map((o) => o.key));
    const brokenReferences = assetRows.filter((r) => !bucketKeys.has(r.storage_key));

    console.log(`\n${apply ? "APPLY" : "DRY RUN"} summary:`);
    console.log(`  Orphaned objects (no row claims them, older than the grace period): ${safeOrphans.length}`);
    for (const o of safeOrphans) console.log(`    ${o.key}  (${o.size} bytes, last modified ${o.lastModified})`);
    if (malformed.length > 0) {
      console.log(`  Malformed keys found while scanning (never auto-deleted — investigate by hand): ${malformed.length}`);
      for (const o of malformed) console.log(`    ${o.key}`);
    }
    console.log(
      `  Broken references (row exists, object missing — investigate; not deleted by this script): ${brokenReferences.length}`,
    );
    for (const r of brokenReferences) {
      console.log(`    asset ${r.id} (business ${r.business_id}) → missing key ${r.storage_key}`);
    }

    if (!apply || safeOrphans.length === 0) {
      if (!apply && safeOrphans.length > 0) {
        console.log(`\nRe-run with --apply --backup-confirmed to delete the ${safeOrphans.length} orphaned object(s) above.`);
      }
      return 0;
    }

    console.log(`\nDeleting ${safeOrphans.length} orphaned object(s) …`);
    let deleted = 0;
    for (const o of safeOrphans) {
      try {
        await s3Delete(s3Config, o.key);
        deleted += 1;
      } catch (error) {
        console.error(`  failed to delete ${o.key}:`, error instanceof Error ? error.message : error);
      }
    }
    console.log(`Deleted ${deleted}/${safeOrphans.length} orphaned object(s). No database row was touched.`);
    return 0;
  } finally {
    await client.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
