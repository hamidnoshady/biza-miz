/**
 * Personnel-file reconciliation (issue #947, TEAM-F04 / TEAM-F05).
 *
 * ## What it repairs
 *
 * Every door that creates or changes a membership is supposed to leave the person a
 * personnel file: a `parties` row with the `Employee` role whose `employee_user_id`
 * points back at the membership, carrying the membership's canonical name, phone and
 * email. The guarantee lives in `src/lib/personnel-file.ts` and runs on create,
 * update, rehire, phone change, invitation acceptance, setup and IAM replica apply —
 * but it runs *after* the membership transaction commits, on purpose (see that
 * module's «Why not inside the membership transaction»), so a write that fails leaves
 * a recorded debt instead of a rolled-back hire.
 *
 * This script is the other half of that contract: it walks the open
 * `personnel_file_drift` rows and retries each one, then reports what is still owed.
 * It is what makes «durable retry» a real claim rather than a wish — `GET /api/team`
 * retries a handful on each visit, and this is the sweep an operator or a cron runs
 * when nobody is opening that screen.
 *
 * ## What it deliberately does not do
 *
 * - **No name matching.** A standalone personnel file that happens to carry the same
 *   name as a member is not «the same person» — merging by name is how two people's
 *   payslips end up on one file. The issue forbids it and this script has no code
 *   path that could.
 * - **No link rewriting.** `employee_user_id` is set only by the membership sync,
 *   which validates the target (`assertEmployeeLinkTarget`) and audits the change.
 * - **No deletion.** A file that cannot be created twice (a link already taken by
 *   another row) is reported, not resolved by force.
 * - **No dry run by default**: the retry is idempotent and only ever *completes* what
 *   the product already promised, so there is no destructive mode to gate.
 *
 * Usage:
 *   npm run personnel:reconcile                      # every business, every owed file
 *   npm run personnel:reconcile -- --business=<uuid> # one business (the usual cron)
 *   npm run personnel:reconcile -- --limit=500       # cap the rows touched per business
 *
 * Exit status: 0 when nothing is owed afterwards, 1 when some files remain in drift —
 * so a scheduled run is visible in whatever supervises it. The rows are also printed,
 * with the reason and the last error, for whoever reads the log.
 *
 * `main()` is wrapped rather than using top-level await: the root package.json is
 * CommonJS, under which tsx rejects top-level await (see the same note in
 * scripts/media-reconcile-orphans.ts).
 */
import "dotenv/config";
import { Client } from "pg";

interface DriftRow {
  business_id: string;
  user_id: string;
  reason: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: Date;
  full_name: string;
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required.");
    return 2;
  }
  const businessArg = process.argv.find((a) => a.startsWith("--business="))?.split("=")[1] ?? null;
  const limitArg = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "500");
  const limit = Number.isFinite(limitArg) ? Math.max(1, Math.min(Math.trunc(limitArg), 5000)) : 500;

  /*
   * A dedicated client, bypassing row-level security for the *reads* only.
   *
   * The scope (business / business-wide bypass) has to be chosen per statement, and
   * `personnel_file_drift` is RLS-enabled and forced like every other tenant table.
   * The script therefore reads with the bypass on — it is a maintenance tool run by an
   * operator against their own database — while every write it performs goes through
   * `ensurePersonnelFileForMembership`, which sets the tenant scope itself and does
   * its own same-business lookups.
   */
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const { rows: owed } = await client.query<DriftRow>(
    `SELECT d.business_id, d.user_id, d.reason, d.attempts, d.last_error, d.last_attempt_at,
            coalesce(u.full_name, '') AS full_name
       FROM personnel_file_drift d
       LEFT JOIN users u ON u.id = d.user_id AND u.business_id = d.business_id
      WHERE d.resolved_at IS NULL
        AND ($1::uuid IS NULL OR d.business_id = $1::uuid)
      ORDER BY d.business_id, d.last_attempt_at
      LIMIT $2`,
    [businessArg, limit],
  );
  await client.end();

  if (owed.length === 0) {
    console.log("Personnel files: nothing owed.");
    return 0;
  }
  console.log(`Personnel files: ${owed.length} member(s) owed a file.`);

  /*
   * The retry itself runs through the app's own service, not through SQL here: the
   * guarantee (what the file should say, when to refuse to invent a name, how a
   * failure is recorded) has exactly one implementation, and a script that re-wrote it
   * would be the second answer this issue exists to remove.
   *
   * Imported dynamically so the module graph (which reaches `@/lib/db`, whose pool
   * wants the environment set and the tenant scoping installed) is loaded *after*
   * `dotenv/config` has run.
   */
  const { retryPersonnelFileDrift } = await import("../src/lib/personnel-file");
  const { getPool } = await import("../src/lib/db");

  const byBusiness = new Map<string, number>();
  for (const row of owed) byBusiness.set(row.business_id, (byBusiness.get(row.business_id) ?? 0) + 1);

  let repaired = 0;
  let remaining = 0;
  for (const [businessId, count] of byBusiness) {
    const result = await retryPersonnelFileDrift(businessId, { limit: count });
    repaired += result.repaired;
    remaining += result.remaining;
    console.log(
      `  ${businessId}: ${result.attempted} attempted, ${result.repaired} repaired, ${result.remaining} still owed`,
    );
  }

  /*
   * The app's pool is closed before returning. `ensurePersonnelFileForMembership`
   * reads and writes through `src/lib/db`'s pool, and an idle pool keeps the Node
   * event loop alive — a script that repaired nothing but never exited is a cron job
   * that runs until it is killed.
   */
  await getPool()
    .end()
    .catch(() => {});

  if (remaining === 0) {
    console.log(`Personnel files: all repaired (${repaired}).`);
    return 0;
  }

  console.warn(
    `Personnel files: ${remaining} member(s) still owe a file after ${repaired} repair(s). Each row below names the reason and the last error.`,
  );
  for (const row of owed) {
    console.warn(
      `  - ${row.business_id} / ${row.user_id} (${row.full_name || "بدون نام"}): ${row.reason}` +
        `${row.last_error ? ` — ${row.last_error}` : ""} — ${row.attempts} attempt(s), last ${row.last_attempt_at.toISOString()}`,
    );
  }
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("personnel reconciliation failed:", error);
    process.exitCode = 2;
  });
