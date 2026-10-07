/**
 * Issue #748 / migration 0183 — backfill the legacy plaintext LiteLLM master
 * and tenant virtual keys into their AES-256-GCM ciphertext columns.
 *
 * Run against every deployment database BEFORE migration 0209:
 *
 *   npm run db:encrypt-ai-secrets -- --dry-run
 *   npm run db:encrypt-ai-secrets
 *   npm run db:encrypt-ai-secrets -- --verify-only
 *
 * Application reads are ciphertext-only in the cutover release. The normal
 * run is idempotent/resumable: it writes missing ciphertext, verifies every
 * ciphertext decrypts to the matching plaintext when both are present, and
 * only then clears the legacy plaintext copies. Migration 0209 refuses to
 * drop the old columns if any non-empty plaintext key lacks ciphertext. Do not
 * run the migration until final verify-only and production runtime-read checks
 * succeed on every deployment.
 *
 * These are platform-scope tables (`platform_ai_gateway`, `ai_business_gateway`
 * under the platform bypass), so the command runs once per deployment database
 * rather than looping through tenant DEKs like `encrypt-fields.ts` does.
 */
import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, query, withoutTenantScope } from "../src/lib/db";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../src/lib/integrations/secrets";

export type Args = { dryRun: boolean; verifyOnly: boolean };

export function parseArgs(argv: string[]): Args {
  return { dryRun: argv.includes("--dry-run"), verifyOnly: argv.includes("--verify-only") };
}

async function migrateGatewaySingleton(dryRun: boolean, key: Buffer): Promise<number> {
  return withoutTenantScope("ai gateway secrets backfill", async () => {
    const { rows } = await query<{ master_key: string }>(
      `SELECT master_key FROM platform_ai_gateway
        WHERE id = true
          AND NULLIF(btrim(master_key), '') IS NOT NULL
          AND NULLIF(btrim(master_key_ciphertext), '') IS NULL`,
    );
    if (rows.length === 0 || dryRun) return rows.length;

    const masterKey = rows[0].master_key;
    const ciphertext = encryptSecret(masterKey, key);
    const result = await query(
      `UPDATE platform_ai_gateway
          SET master_key_ciphertext = $1
        WHERE id = true
          AND master_key = $2
          AND NULLIF(btrim(master_key), '') IS NOT NULL
          AND NULLIF(btrim(master_key_ciphertext), '') IS NULL`,
      [ciphertext, masterKey],
    );
    return result.rowCount ?? 0;
  });
}

async function migrateBusinessGateways(dryRun: boolean, batchSize: number, key: Buffer): Promise<number> {
  return withoutTenantScope("ai gateway secrets backfill", async () => {
    if (dryRun) {
      const { rows } = await query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ai_business_gateway
          WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
            AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL`,
      );
      return Number(rows[0]?.count ?? 0);
    }

    let migrated = 0;
    for (;;) {
      const { rows } = await query<{ id: string; virtual_key: string }>(
        `SELECT id, virtual_key FROM ai_business_gateway
          WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
            AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL
          ORDER BY id
          LIMIT $1`,
        [batchSize],
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        const ciphertext = encryptSecret(row.virtual_key, key);
        const result = await query(
          `UPDATE ai_business_gateway
              SET virtual_key_ciphertext = $1
            WHERE id = $2
              AND virtual_key = $3
              AND NULLIF(btrim(virtual_key), '') IS NOT NULL
              AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL`,
          [ciphertext, row.id, row.virtual_key],
        );
        migrated += result.rowCount ?? 0;
      }
    }
    return migrated;
  });
}

export function assertDecryptable(
  ciphertext: string,
  label: string,
  key: Buffer,
  plaintext?: string | null,
): string {
  try {
    const decrypted = decryptSecret(ciphertext, key);
    if (!decrypted) throw new Error("decrypted value is empty");
    if (plaintext && plaintext.trim() && decrypted !== plaintext) {
      throw new Error("ciphertext does not match the legacy plaintext value");
    }
    return decrypted;
  } catch (cause) {
    throw new Error(`ai_gateway_secret_ciphertext_invalid:${label}`, { cause });
  }
}

async function assertNoUnbackfilledSecrets(): Promise<number> {
  const { rows } = await query<{ missing_count: string }>(
    `SELECT
       (SELECT count(*) FROM platform_ai_gateway
         WHERE NULLIF(btrim(master_key), '') IS NOT NULL
           AND NULLIF(btrim(master_key_ciphertext), '') IS NULL)
       +
       (SELECT count(*) FROM ai_business_gateway
         WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
           AND NULLIF(btrim(virtual_key_ciphertext), '') IS NULL)
       AS missing_count`,
  );
  return Number(rows[0]?.missing_count ?? 0);
}

async function countLegacySecrets(): Promise<number> {
  const { rows } = await query<{ platform_count: string; business_count: string }>(
    `SELECT
       (SELECT count(*)::text FROM platform_ai_gateway
         WHERE NULLIF(btrim(master_key), '') IS NOT NULL) AS platform_count,
       (SELECT count(*)::text FROM ai_business_gateway
         WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL) AS business_count`,
  );
  return Number(rows[0]?.platform_count ?? 0) + Number(rows[0]?.business_count ?? 0);
}

/** Decrypt-check every stored ciphertext; compare with plaintext where available. */
async function verifyStoredCiphertexts(key: Buffer): Promise<number> {
  let verified = 0;
  const { rows: platformRows } = await query<{
    master_key: string | null;
    master_key_ciphertext: string;
  }>(
    `SELECT master_key, master_key_ciphertext FROM platform_ai_gateway
      WHERE NULLIF(btrim(master_key_ciphertext), '') IS NOT NULL`,
  );
  for (const row of platformRows) {
    assertDecryptable(row.master_key_ciphertext, "platform_ai_gateway.master_key_ciphertext", key, row.master_key);
    verified += 1;
  }

  let afterId: string | null = null;
  for (;;) {
    const result = await query<{
      id: string;
      virtual_key: string | null;
      virtual_key_ciphertext: string;
    }>(
      `SELECT id, virtual_key, virtual_key_ciphertext FROM ai_business_gateway
        WHERE NULLIF(btrim(virtual_key_ciphertext), '') IS NOT NULL
          AND ($1::uuid IS NULL OR id > $1::uuid)
        ORDER BY id
        LIMIT 500`,
      [afterId],
    );
    const rows: { id: string; virtual_key: string | null; virtual_key_ciphertext: string }[] = result.rows;
    if (rows.length === 0) break;
    for (const row of rows) {
      assertDecryptable(
        row.virtual_key_ciphertext,
        `ai_business_gateway.virtual_key_ciphertext:${row.id}`,
        key,
        row.virtual_key,
      );
      verified += 1;
    }
    afterId = rows[rows.length - 1].id;
  }
  return verified;
}

/** Clear only after a complete verification pass, rechecking the exact pair per row. */
async function clearVerifiedPlaintext(key: Buffer): Promise<number> {
  return withoutTenantScope("ai gateway legacy secret cleanup", async () => {
    let cleared = 0;
    const { rows: platformRows } = await query<{
      master_key: string;
      master_key_ciphertext: string;
    }>(
      `SELECT master_key, master_key_ciphertext FROM platform_ai_gateway
        WHERE NULLIF(btrim(master_key), '') IS NOT NULL
          AND NULLIF(btrim(master_key_ciphertext), '') IS NOT NULL`,
    );
    for (const row of platformRows) {
      assertDecryptable(row.master_key_ciphertext, "platform_ai_gateway.master_key_ciphertext", key, row.master_key);
      const result = await query(
        `UPDATE platform_ai_gateway SET master_key = NULL
          WHERE id = true AND master_key = $1 AND master_key_ciphertext = $2`,
        [row.master_key, row.master_key_ciphertext],
      );
      cleared += result.rowCount ?? 0;
    }

    let afterId: string | null = null;
    for (;;) {
      const result = await query<{
        id: string;
        virtual_key: string;
        virtual_key_ciphertext: string;
      }>(
        `SELECT id, virtual_key, virtual_key_ciphertext FROM ai_business_gateway
          WHERE NULLIF(btrim(virtual_key), '') IS NOT NULL
            AND NULLIF(btrim(virtual_key_ciphertext), '') IS NOT NULL
            AND ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT 500`,
        [afterId],
      );
      const rows: { id: string; virtual_key: string; virtual_key_ciphertext: string }[] = result.rows;
      if (rows.length === 0) break;
      for (const row of rows) {
        assertDecryptable(
          row.virtual_key_ciphertext,
          `ai_business_gateway.virtual_key_ciphertext:${row.id}`,
          key,
          row.virtual_key,
        );
        const result = await query(
          `UPDATE ai_business_gateway SET virtual_key = NULL
            WHERE id = $1 AND virtual_key = $2 AND virtual_key_ciphertext = $3`,
          [row.id, row.virtual_key, row.virtual_key_ciphertext],
        );
        cleared += result.rowCount ?? 0;
      }
      afterId = rows[rows.length - 1].id;
    }
    return cleared;
  });
}

/** Verify all ciphertexts, then clear stale plaintext copies in normal mode. */
async function verifyAndClearLegacySecrets(
  dryRun: boolean,
  verifyOnly: boolean,
  key: Buffer,
): Promise<{ verified: number; legacyRemaining: number }> {
  return withoutTenantScope("ai gateway secrets verification", async () => {
    const verified = await verifyStoredCiphertexts(key);
    const missing = await assertNoUnbackfilledSecrets();
    if (!dryRun && missing > 0) {
      throw new Error(`ai_gateway_secret_backfill_incomplete:${missing}:run npm run db:encrypt-ai-secrets`);
    }

    let legacyRemaining = await countLegacySecrets();
    if (verifyOnly && legacyRemaining > 0) {
      throw new Error(`ai_gateway_secret_plaintext_remains:${legacyRemaining}:run npm run db:encrypt-ai-secrets before migration 0209`);
    }

    if (!dryRun && !verifyOnly && legacyRemaining > 0) {
      await clearVerifiedPlaintext(key);
      legacyRemaining = await countLegacySecrets();
      if (legacyRemaining > 0) {
        throw new Error(`ai_gateway_secret_plaintext_remains:${legacyRemaining}:check for concurrent legacy writers before migration 0209`);
      }
    }

    return { verified, legacyRemaining };
  });
}

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { dryRun, verifyOnly } = parseArgs(argv);
  if (dryRun && verifyOnly) throw new Error("choose only one of --dry-run or --verify-only");

  const key = resolveEncryptionKey(process.env);
  const gatewayCount = verifyOnly ? 0 : await migrateGatewaySingleton(dryRun, key);
  const businessCount = verifyOnly ? 0 : await migrateBusinessGateways(dryRun, 200, key);
  const verification = await verifyAndClearLegacySecrets(dryRun, verifyOnly, key);
  const mode = verifyOnly ? "verified" : dryRun ? "would encrypt" : "encrypted";
  console.log(`platform_ai_gateway: ${mode} ${gatewayCount} row(s)`);
  console.log(`ai_business_gateway: ${mode} ${businessCount} row(s)`);
  console.log(`ciphertext: verified ${verification.verified} secret(s)`);
  if (verification.legacyRemaining > 0) {
    console.log(`legacy plaintext remains in ${verification.legacyRemaining} row(s); run without --dry-run before migration 0209`);
  }
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
