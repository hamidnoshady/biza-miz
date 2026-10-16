/**
 * Personnel-file reconciliation (issue #947, TEAM-F04 / TEAM-F05).
 *
 * ## What it repairs
 *
 * Every membership is supposed to leave the person a personnel file: a `parties` row
 * with the `Employee` role whose `employee_user_id` points back at the membership,
 * carrying the membership's canonical name, phone and email. Since migration 0223 the
 * obligation is written by the membership write itself (a trigger on `users`), with its
 * phone arm corrected forward-only in 0226 (a *cleared* membership phone is canonical and
 * must clear the file's), the projection lives in `src/lib/personnel-file.ts`, and
 * `GET /api/team` retries a handful of members on each visit.
 *
 * This script is the other half of that contract: it walks **the members the platform
 * actually owes a file**, and repairs each one through the app's own projection.
 *
 * ## Why it does not read `personnel_file_drift` for its work list
 *
 * That table is bookkeeping *about* a debt, and this script is the sweep of last resort —
 * exactly the place where trusting bookkeeping would be wrong. The work list is
 * `listPersonnelFileDebts`: `users` × `parties` compared by the same function the
 * projection writes by. A member whose obligation row was never written (a process that
 * died mid-write before 0223, a restored dump, an operator who cleaned the table) is
 * still found, because the data is the evidence. Open drift rows are unioned in on top of
 * it, so stale bookkeeping is cleared too rather than left behind as a permanent warning.
 *
 * Each debt prints whether a drift row recorded it (`recorded`): when the answer is «no»,
 * the write path lost the obligation, which is the alarm this whole mechanism exists to
 * raise. Since 0223 that can no longer happen for a membership write — but a *pre*0223
 * row, a manual repair or a restored backup can still produce one.
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
 * - **No SQL of its own for the repair.** The projection (what the file should say, when
 *   to refuse to invent a name, how a failure is recorded) has exactly one
 *   implementation; a script that re-wrote it would be the second answer this issue
 *   exists to remove.
 * - **No dry run by default**: the retry is idempotent and only ever *completes* what
 *   the product already promised, so there is no destructive mode to gate. `--dry-run`
 *   exists for the report alone — it still prints the inventory, and touches nothing.
 *
 * Usage:
 *   npm run personnel:reconcile                      # every business, every owed file
 *   npm run personnel:reconcile -- --business=<uuid> # one business (the usual cron)
 *   npm run personnel:reconcile -- --limit=500       # cap the members touched per business
 *   npm run personnel:reconcile -- --dry-run         # report only
 *
 * Exit status: 0 when nothing is owed afterwards, 1 when some files remain in drift —
 * so a scheduled run is visible in whatever supervises it. The members are also printed,
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
  const dryRun = process.argv.includes("--dry-run");

  /*
   * A dedicated client, bypassing row-level security for the *reads* only.
   *
   * The scope has to be chosen per statement, and every tenant table is RLS-enabled and
   * forced. The script therefore reads with the bypass on — it is a maintenance tool run
   * by an operator against their own database — while every write it performs goes
   * through `ensurePersonnelFileForMembership`, which sets the tenant scope itself and
   * does its own same-business lookups.
   */
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const { rows: businesses } = await client.query<{ business_id: string }>(
    `SELECT DISTINCT business_id
       FROM users
      WHERE ($1::uuid IS NULL OR business_id = $1::uuid)
      ORDER BY business_id`,
    [businessArg],
  );

  // Dynamic imports so the module graph (which reaches `@/lib/db`, whose pool wants the
  // environment set and the tenant scoping installed) loads *after* `dotenv/config`.
  const { listPersonnelFileDebts, retryPersonnelFileDrift } = await import("../src/lib/personnel-file");
  const { getPool, withTenant } = await import("../src/lib/db");

  interface Work {
    businessId: string;
    userId: string;
    fullName: string;
    reason: string;
    recorded: boolean;
    lastError: string | null;
    attempts: number;
  }

  /** The inventory, plus the open bookkeeping rows that name a member not in it. */
  async function collect(): Promise<Work[]> {
    const work = new Map<string, Work>();
    for (const { business_id } of businesses) {
      const debts = await withTenant(business_id, () => listPersonnelFileDebts(business_id));
      for (const debt of debts) {
        work.set(`${business_id}:${debt.userId}`, {
          businessId: business_id,
          userId: debt.userId,
          fullName: debt.fullName,
          reason: debt.reason,
          recorded: debt.recorded,
          lastError: null,
          attempts: 0,
        });
      }
    }

    const { rows: drift } = await client.query<DriftRow>(
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
    for (const row of drift) {
      const key = `${row.business_id}:${row.user_id}`;
      const existing = work.get(key);
      if (existing) {
        existing.recorded = true;
        existing.lastError = row.last_error;
        existing.attempts = row.attempts;
        continue;
      }
      // The file is in line (or the member is gone) and only the record is stale: still
      // work, because the retry is what closes the episode.
      work.set(key, {
        businessId: row.business_id,
        userId: row.user_id,
        fullName: row.full_name,
        reason: row.reason,
        recorded: true,
        lastError: row.last_error,
        attempts: row.attempts,
      });
    }
    return [...work.values()];
  }

  const owed = await collect();
  const unrecorded = owed.filter((item) => !item.recorded);
  if (owed.length === 0) {
    console.log("Personnel files: nothing owed.");
    await client.end();
    return 0;
  }
  console.log(
    `Personnel files: ${owed.length} member(s) owed a file` +
      (unrecorded.length > 0 ? `, ${unrecorded.length} without a recorded obligation.` : "."),
  );
  for (const item of owed) {
    console.log(
      `  - ${item.businessId} / ${item.userId} (${item.fullName || "بدون نام"}): ${item.reason}` +
        `${item.recorded ? "" : " — not recorded in personnel_file_drift"}${item.lastError ? ` — ${item.lastError}` : ""}`,
    );
  }

  if (dryRun) {
    console.warn("Dry run: nothing was attempted.");
    await client.end();
    return owed.length === 0 ? 0 : 1;
  }

  const byBusiness = new Map<string, number>();
  for (const item of owed) byBusiness.set(item.businessId, (byBusiness.get(item.businessId) ?? 0) + 1);

  let repaired = 0;
  for (const [businessId, count] of byBusiness) {
    const result = await retryPersonnelFileDrift(businessId, { limit: count });
    repaired += result.repaired;
    console.log(
      `  ${businessId}: ${result.attempted} attempted, ${result.repaired} repaired, ${result.remaining} still owed`,
    );
  }

  /*
   * The report is the inventory again — the same evidence, read after the repairs. Not
   * `retryPersonnelFileDrift`'s `remaining`: that counts open rows, and «no rows but a
   * member still has no file» is precisely the state this script must not call healthy.
   */
  const remaining = await collect();
  if (remaining.length === 0) {
    console.log(`Personnel files: all repaired (${repaired} of ${owed.length}).`);
    await getPool()
      .end()
      .catch(() => {});
    await client.end();
    return 0;
  }

  console.warn(
    `Personnel files: ${remaining.length} member(s) still owe a file after ${repaired} repair(s). Each one below names the reason and the last error.`,
  );
  for (const item of remaining) {
    console.warn(
      `  - ${item.businessId} / ${item.userId} (${item.fullName || "بدون نام"}): ${item.reason}` +
        `${item.lastError ? ` — ${item.lastError}` : ""}` +
        `${item.attempts > 0 ? ` — ${item.attempts} attempt(s)` : ""}`,
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
  await client.end();
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
