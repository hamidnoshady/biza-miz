/**
 * Issue #903 §12 — run a recovery drill for one business.
 *
 * The drill proves, without writing anything to the business, that its newest
 * (or a named) logical artifact can still be opened and would be allowed to be
 * restored: decrypt → parse as this build's archive → preview → portable
 * envelope.
 *
 * Usage:
 *   npx tsx scripts/backup-drill.ts --business <uuid>
 *   npx tsx scripts/backup-drill.ts --business <uuid> --ref <opaque-ref>
 *   npx tsx scripts/backup-drill.ts --business <uuid> --recovery-passphrase '…'
 *
 * Exit code 0 only when every step passed. A skipped step (no passphrase) is
 * printed as SKIPPED and fails the drill — a drill that does not prove the
 * envelope must not report success.
 *
 * `--json` prints the report machine-readably for a scheduler.
 */
import "dotenv/config";
import { runDrill } from "../src/lib/tenant-backup-drill";
import { deploymentRole } from "../src/lib/deployment-role";
import { readDeploymentProfile } from "../src/lib/deployment-mode";
import { closeDatabasePool } from "../src/lib/db";

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<number> {
  const businessId = arg("business");
  if (!businessId) {
    console.error("usage: backup-drill --business <uuid> [--ref <ref>] [--recovery-passphrase <p>] [--json]");
    return 2;
  }

  const report = await runDrill({
    businessId,
    ref: arg("ref"),
    deployment: {
      role: deploymentRole(),
      profile: (await readDeploymentProfile(businessId)).profile,
    },
    recoveryPassphrase: arg("recovery-passphrase"),
  });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`drill for ${businessId} — ${report.ok ? "PASS" : "FAIL"}`);
    console.log(`  artifact: ${report.ref ?? "(none)"}`);
    for (const step of report.steps) {
      console.log(`  ${step.status.toUpperCase().padEnd(8)} ${step.step}: ${step.detail}`);
    }
  }
  return report.ok ? 0 : 1;
}

main()
  .then(async (code) => {
    await closeDatabasePool().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("drill failed:", error instanceof Error ? error.message : String(error));
    await closeDatabasePool().catch(() => undefined);
    process.exit(1);
  });
