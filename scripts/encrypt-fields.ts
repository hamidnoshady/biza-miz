/**
 * Phase 24 Wave 3, step 2 — backfill the `*_enc` / `*_bidx` columns added by
 * `migrations/0125_field_encryption_columns.sql`.
 *
 *   npm run db:encrypt-fields              # every business
 *   npm run db:encrypt-fields -- --business <uuid>
 *   npm run db:encrypt-fields -- --dry-run
 *   npm run db:encrypt-fields -- --batch 500
 *
 * Three properties, all of them load-bearing:
 *
 *  - **Idempotent and resumable.** Every pass selects `WHERE col_enc IS NULL
 *    AND col IS NOT NULL`, so re-running after a crash, a deploy, or the
 *    BEFORE UPDATE trigger invalidating a row (see the migration) picks up
 *    exactly what is left. Running it twice is not an error and does not
 *    re-encrypt what is already done.
 *  - **Tenant-scoped writes.** Businesses are enumerated once under the
 *    platform bypass, then every read and write for a business happens inside
 *    `withTenant(businessId, …)`, per CLAUDE.md's background-work rule — the
 *    same RLS that protects a request protects the backfill.
 *  - **Batched.** A single `UPDATE … FROM (VALUES …)` per batch rather than a
 *    statement per row, and a `LIMIT` per pass so a large customer table does
 *    not become one long-running transaction holding locks over a service.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query, withTenant, withoutTenantScope } from "../src/lib/db";
import { getBusinessDek } from "../src/lib/business-keys";
import { encryptField, phoneBlindIndex, phoneKind, phoneLast4 } from "../src/lib/field-crypto";
import { ENCRYPTED_TABLES } from "../src/lib/encrypted-columns";
import { isFieldEncryptionEnabled, masterKeyStatus } from "../src/lib/master-key";
import { sealServerSyncConfig } from "../src/lib/server-sync-secret";

export interface Options {
  businessId: string | null;
  batchSize: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { businessId: null, batchSize: 500, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--business") options.businessId = argv[++i] ?? null;
    else if (arg === "--batch") options.batchSize = Math.max(1, Math.min(5000, Number(argv[++i]) || 500));
    else if (arg === "--dry-run") options.dryRun = true;
  }
  return options;
}

interface BusinessRow extends Record<string, unknown> {
  id: string;
  name: string;
}

async function listBusinesses(only: string | null): Promise<BusinessRow[]> {
  return withoutTenantScope("enumerate businesses for the field-encryption backfill", async () => {
    if (only) {
      const { rows } = await query<BusinessRow>(`SELECT id, name FROM businesses WHERE id = $1`, [only]);
      return rows;
    }
    const { rows } = await query<BusinessRow>(`SELECT id, name FROM businesses ORDER BY created_at`);
    return rows;
  });
}

/**
 * `reservations` has no `business_id` — it hangs off `location_id` (RLS shape
 * 2). Inside `withTenant` the policy already restricts it to the business's
 * own branches, so the pass needs no extra predicate; this only records which
 * tables need one if they are ever queried outside a tenant scope.
 */
const TENANT_PREDICATE: Record<string, (alias: string) => string> = {
  parties: (t) => `${t}business_id = $1`,
  // Only the reservation's own column is aliased — the `business_id` inside
  // the subquery belongs to `locations` and must not be.
  reservations: (t) => `${t}location_id IN (SELECT id FROM locations WHERE business_id = $1)`,
};

export interface PassResult {
  scanned: number;
  encrypted: number;
}

export async function encryptTable(
  businessId: string,
  table: string,
  options: Options,
): Promise<PassResult> {
  const columns = ENCRYPTED_TABLES[table].columns;
  const predicate = TENANT_PREDICATE[table];
  const whereSelect = predicate("");
  const whereUpdate = predicate("t.");
  const result: PassResult = { scanned: 0, encrypted: 0 };

  // One pass per column set: a row is picked up if *any* of its ciphertext
  // twins is missing, and every missing one is filled in the same update.
  // `<> ''` matters: an empty-string plaintext encrypts to SQL NULL (absence
  // round-trips as NULL, never as the ciphertext of ""), so without this the
  // row would match `col_enc IS NULL` again on the next pass and the loop
  // would never drain.
  const missing = columns
    .map((c) => `(${c.column} IS NOT NULL AND ${c.column} <> '' AND ${c.encColumn} IS NULL)`)
    .join(" OR ");
  const selectList = ["id", ...columns.map((c) => c.column)].join(", ");

  // A dry run counts rather than pages: the loop below advances only because
  // each batch stops matching `missing` once it is written, so a dry run that
  // paged would re-select the same first batch forever.
  if (options.dryRun) {
    const pending = await withTenant(businessId, async () => {
      const { rows } = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} WHERE ${whereSelect} AND (${missing})`,
        [businessId],
      );
      return Number(rows[0]?.count ?? 0);
    });
    return { scanned: pending, encrypted: pending };
  }

  for (;;) {
    const rows = await withTenant(businessId, async () => {
      const { rows } = await query<Record<string, unknown>>(
        `SELECT ${selectList} FROM ${table}
          WHERE ${whereSelect} AND (${missing})
          ORDER BY id
          LIMIT ${options.batchSize}`,
        [businessId],
      );
      return rows;
    });
    if (rows.length === 0) break;
    result.scanned += rows.length;

    const dek = await getBusinessDek(businessId);
    if (!dek) throw new Error(`no encryption key for business ${businessId}`);

    // UPDATE … FROM (VALUES …) — one statement per batch. A VALUES alias list
    // takes column *names* only (`AS v(id, phone_enc)`), never types, so every
    // type is pinned by an explicit `$n::type` cast on the value itself —
    // which is needed regardless: a column whose batch happens to be all NULLs
    // would otherwise infer as `text` and fail against `bytea`.
    const setColumns: string[] = [];
    const valueColumns: string[] = ["id"];
    for (const col of columns) {
      setColumns.push(`${col.encColumn} = v.${col.encColumn}`);
      valueColumns.push(col.encColumn);
      if (col.bidxColumn) {
        setColumns.push(`${col.bidxColumn} = v.${col.bidxColumn}`);
        valueColumns.push(col.bidxColumn);
      }
      if (col.last4Column) {
        setColumns.push(`${col.last4Column} = v.${col.last4Column}`);
        valueColumns.push(col.last4Column);
      }
      if (col.kindColumn) {
        setColumns.push(`${col.kindColumn} = v.${col.kindColumn}`);
        valueColumns.push(col.kindColumn);
      }
    }

    const params: unknown[] = [businessId];
    const tuples: string[] = [];
    for (const row of rows) {
      const placeholders: string[] = [];
      const push = (value: unknown, cast: string) => {
        params.push(value);
        placeholders.push(`$${params.length}::${cast}`);
      };
      push(row.id, "uuid");
      for (const col of columns) {
        const plain = row[col.column];
        const text = typeof plain === "string" && plain !== "" ? plain : null;
        push(text ? encryptField(text, dek) : null, "bytea");
        if (col.bidxColumn) push(text ? phoneBlindIndex(text, dek) : null, "text");
        if (col.last4Column) push(text ? phoneLast4(text) : null, "text");
        if (col.kindColumn) push(text ? phoneKind(text) : null, "text");
      }
      tuples.push(`(${placeholders.join(", ")})`);
    }

    await withTenant(businessId, async () => {
      await query(
        `UPDATE ${table} AS t
            SET ${setColumns.join(", ")}
           FROM (VALUES ${tuples.join(", ")}) AS v(${valueColumns.join(", ")})
          WHERE t.id = v.id AND ${whereUpdate}`,
        params,
      );
    });
    result.encrypted += rows.length;

    // A short pass means the table is drained; anything the trigger
    // invalidates after this point is the next run's problem, by design.
    if (rows.length < options.batchSize) break;
  }

  return result;
}

/** Encrypt the JSON-held sync bearer token without exposing it to SQL/logs. */
export async function backfillServerSyncConfig(
  businessId: string,
  options: Partial<Options> = {},
): Promise<PassResult> {
  const dryRun = options.dryRun === true;
  return withTenant(businessId, async () => {
    const pending = `business_id = $1 AND location_id IS NULL AND key = 'server_sync.config'
      AND jsonb_typeof(value->'token') = 'string' AND value->>'token' <> ''`;
    if (dryRun) {
      const { rows } = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM settings WHERE ${pending}`,
        [businessId],
      );
      const count = Number(rows[0]?.count ?? 0);
      return { scanned: count, encrypted: count };
    }
    const selected = await query<{ value: unknown }>(
      `SELECT value FROM settings WHERE ${pending}`,
      [businessId],
    );
    if (!selected.rows[0]) return { scanned: 0, encrypted: 0 };
    const previous = selected.rows[0].value;
    const sealed = sealServerSyncConfig(previous);
    const updated = await query(
      `UPDATE settings SET value = $3::jsonb, updated_at = now()
        WHERE business_id = $1 AND location_id IS NULL AND key = 'server_sync.config' AND value = $2::jsonb`,
      [businessId, JSON.stringify(previous), JSON.stringify(sealed)],
    );
    return { scanned: 1, encrypted: updated.rowCount ?? 0 };
  });
}

/** One business, every registered table plus the JSON sync credential. */
export async function backfillBusiness(
  businessId: string,
  options: Partial<Options> = {},
): Promise<PassResult> {
  const opts: Options = { businessId, batchSize: 500, dryRun: false, ...options };
  const total: PassResult = { scanned: 0, encrypted: 0 };
  for (const table of Object.keys(ENCRYPTED_TABLES)) {
    const pass = await encryptTable(businessId, table, opts);
    total.scanned += pass.scanned;
    total.encrypted += pass.encrypted;
  }
  const syncConfig = await backfillServerSyncConfig(businessId, opts);
  total.scanned += syncConfig.scanned;
  total.encrypted += syncConfig.encrypted;
  return total;
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!isFieldEncryptionEnabled()) {
    console.error(
      "No master key. Set POS_MASTER_KEY (32 bytes, base64 or hex) or POS_MASTER_PASSPHRASE and run again.\n" +
        "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Master key source: ${masterKeyStatus().source}${options.dryRun ? " (dry run)" : ""}`);

  const businesses = await listBusinesses(options.businessId);
  if (businesses.length === 0) {
    console.log(options.businessId ? "No such business." : "No businesses to process.");
    return;
  }

  let totalRows = 0;
  for (const business of businesses) {
    console.log(`\n— ${business.name} (${business.id})`);
    for (const table of Object.keys(ENCRYPTED_TABLES)) {
      try {
        const { encrypted } = await encryptTable(business.id, table, options);
        totalRows += encrypted;
        console.log(`    ${table}: ${encrypted} row(s) ${options.dryRun ? "would be encrypted" : "encrypted"}`);
      } catch (err) {
        // One business's failure — a shredded key, a table that does not exist
        // on an older install — must not abandon the rest. The pass is
        // resumable, so the operator can fix and re-run.
        console.error(`    ${table}: FAILED — ${(err as Error).message}`);
        process.exitCode = 1;
      }
    }
    try {
      const { encrypted } = await backfillServerSyncConfig(business.id, options);
      totalRows += encrypted;
      console.log(`    server_sync.config: ${encrypted} row(s) ${options.dryRun ? "would be encrypted" : "encrypted"}`);
    } catch (err) {
      console.error(`    server_sync.config: FAILED — ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  console.log(
    `\n${options.dryRun ? "Would encrypt" : "Encrypted"} ${totalRows} row(s) across ${businesses.length} business(es).`,
  );
}

// Importable (the integration test drives `backfillBusiness` directly) but
// still runnable as `npm run db:encrypt-fields` — the same entry-point guard
// scripts/migrate.ts uses.
const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end();
    });
}
