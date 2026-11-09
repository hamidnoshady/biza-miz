import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { collectPreflight, preflightDatabase, UUID, type ReviewEvidence } from "../src/lib/financial-migration-preflight";

const evidenceFields = new Set<keyof ReviewEvidence>([
  "snapshotSha256", "encryptedBackupEvidenceSha256", "testedRestoreEvidenceSha256",
  "clientAndQueueEvidenceSha256", "ownerMappingEvidenceSha256", "pendingSettlementEvidenceSha256",
]);

async function readEvidence(file: string | undefined, tenantId: string): Promise<ReviewEvidence | undefined> {
  if (!file) return undefined;
  const input: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!input || typeof input !== "object" || !("tenantId" in input) || input.tenantId !== tenantId) {
    throw new Error("Evidence tenant does not match the requested tenant.");
  }
  const { tenantId: _, ...evidence } = input;
  if (Object.entries(evidence).some(([key, value]) => !evidenceFields.has(key as keyof ReviewEvidence) ||
      typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Invalid evidence digest or field.");
  }
  return evidence;
}

async function main() {
  const [tenantId, evidenceFile, extra] = process.argv.slice(2);
  if (!tenantId || !UUID.test(tenantId) || extra !== undefined) {
    process.stderr.write("Usage: npx tsx scripts/financial-migration-preflight.ts <tenant-uuid> [evidence.json]\n");
    process.exitCode = 1;
    return;
  }
  const connectionString = process.env.ESH154_PREFLIGHT_DATABASE_URL;
  let database: string;
  let evidence: ReviewEvidence | undefined;
  try {
    database = preflightDatabase(connectionString);
    evidence = await readEvidence(evidenceFile, tenantId);
  } catch {
    process.stderr.write("Invalid preflight target or evidence. Use a loopback database named esh154_preflight_* and a tenant-matched evidence file.\n");
    process.exitCode = 1;
    return;
  }
  const client = new Client({ connectionString, application_name: "esh154_read_only_preflight", connectionTimeoutMillis: 5000,
    options: "-c default_transaction_read_only=on -c search_path=pg_catalog,public" });
  client.on("error", () => { process.exitCode = 1; });
  try {
    await client.connect();
    const report = await collectPreflight(client, database, tenantId, evidence);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.classification === "READY" ? 0 : 2;
  } catch (err) {
    // Driver errors can include query values, role names and connection URLs.
    const code = typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" &&
      /^[A-Z0-9]{5}$/.test(err.code) ? ` (SQLSTATE ${err.code})` : "";
    process.stderr.write(`Preflight could not read the tenant snapshot${code}. Check the local copy, tenant and reader grants.\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
