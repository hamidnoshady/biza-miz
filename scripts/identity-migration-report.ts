/**
 * Read-only operator diagnostic report for global identity invariants
 * (ESH-199 / #1384).
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run db:identity-report
 *   DATABASE_URL=postgres://... npm run db:identity-report -- --strict
 *
 * Prints a PII-redacted JSON report covering:
 *   - global identity counts (verified phones/emails, passwordless, phone-only, national IDs)
 *   - normalized cross-identity phone conflicts (`v_platform_verified_phone_conflicts`)
 *   - normalized single-identity multi-phone conflicts (`v_platform_verified_phone_identity_conflicts`)
 *   - landline / unparseable verified-phone anomalies (`v_platform_verified_phone_anomalies`)
 *   - national-ID ciphertext / blind-index integrity checks (zero PII emitted)
 *   - unlinked memberships split by PIN-only staff vs password-role anomalies
 *
 * Exits 0 by default (advisory report); with `--strict`, exits 2 when
 * `report.healthy === false`.
 */
import { getPool } from "../src/lib/db";
import { collectIdentityMigrationReport } from "../src/lib/iam/identity-migration-repair";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    process.stderr.write("ERROR: DATABASE_URL is required.\n");
    process.exit(1);
  }
  const strict = process.argv.includes("--strict");
  try {
    const report = await collectIdentityMigrationReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (strict && !report.healthy) {
      process.exitCode = 2;
    }
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  process.stderr.write(
    `identity-migration-report failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
