/**
 * Issue #748 / migration 0183 — backfill `master_key_ciphertext` and
 * `virtual_key_ciphertext` from the legacy plaintext columns.
 *
 *   npm run db:encrypt-ai-secrets
 *   npm run db:encrypt-ai-secrets -- --dry-run
 *
 * `ai-gateway-service.ts` already reads the ciphertext column first and
 * falls back to plaintext, and already only ever WRITES the ciphertext
 * column — so a deployment that never runs this script keeps working
 * (every credential re-saved through the console self-migrates), but a
 * credential nobody has touched since before migration 0183 stays plaintext
 * at rest until this backfill runs once.
 *
 * Idempotent and resumable: every pass only touches rows whose ciphertext is
 * still NULL and whose plaintext is not, so re-running after a partial
 * failure or on a schedule is a no-op once every row is done. Platform-scope
 * tables (`platform_ai_gateway`, `ai_business_gateway` under the platform
 * bypass), so this runs once for the whole deployment — there is no
 * per-business loop the way `encrypt-fields.ts` needs for tenant DEKs.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query, withoutTenantScope } from "../src/lib/db";
import { encryptSecret, resolveEncryptionKey } from "../src/lib/integrations/secrets";

function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

async function migrateGatewaySingleton(dryRun: boolean): Promise<number> {
  return withoutTenantScope("ai gateway secrets backfill", async () => {
    const { rows } = await query<{ master_key: string | null }>(
      `SELECT master_key FROM platform_ai_gateway
        WHERE id = true AND master_key IS NOT NULL AND master_key <> '' AND master_key_ciphertext IS NULL`,
    );
    if (rows.length === 0) return 0;
    if (dryRun) return rows.length;

    const key = resolveEncryptionKey(process.env);
    const ciphertext = encryptSecret(rows[0].master_key!, key);
    await query(
      `UPDATE platform_ai_gateway SET master_key_ciphertext = $1, master_key = NULL WHERE id = true`,
      [ciphertext],
    );
    return 1;
  });
}

async function migrateBusinessGateways(dryRun: boolean, batchSize: number): Promise<number> {
  return withoutTenantScope("ai gateway secrets backfill", async () => {
    let migrated = 0;
    const key = resolveEncryptionKey(process.env);
    for (;;) {
      const { rows } = await query<{ id: string; virtual_key: string }>(
        `SELECT id, virtual_key FROM ai_business_gateway
          WHERE virtual_key IS NOT NULL AND virtual_key <> '' AND virtual_key_ciphertext IS NULL
          LIMIT $1`,
        [batchSize],
      );
      if (rows.length === 0) break;
      if (dryRun) return migrated + rows.length;

      for (const row of rows) {
        const ciphertext = encryptSecret(row.virtual_key, key);
        await query(
          `UPDATE ai_business_gateway SET virtual_key_ciphertext = $1, virtual_key = NULL WHERE id = $2`,
          [ciphertext, row.id],
        );
        migrated += 1;
      }
    }
    return migrated;
  });
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { dryRun } = parseArgs(argv);
  const gatewayCount = await migrateGatewaySingleton(dryRun);
  const businessCount = await migrateBusinessGateways(dryRun, 200);
  const verb = dryRun ? "would encrypt" : "encrypted";
  console.log(`platform_ai_gateway: ${verb} ${gatewayCount} row(s)`);
  console.log(`ai_business_gateway: ${verb} ${businessCount} row(s)`);
}

// Same entry-point guard as scripts/migrate.ts / encrypt-fields.ts: importable
// for tests, still runnable directly as `npm run db:encrypt-ai-secrets`.
const entryPoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
  void run()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end();
    });
}
