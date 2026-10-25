/**
 * RFM freshness: the job, the debounce, and the rule that matters most.
 *
 * ## The rule that matters most
 *
 * **Scoring must never happen on the checkout path.** RFM is a
 * whole-population quintile calculation — a customer is in the top recency
 * quintile only relative to everyone else — so "rescore because this person
 * just bought something" means scanning every customer and every order. On the
 * payment path that means the till waits for a report on a busy Friday, and,
 * far worse, a failure inside a *reporting* calculation would fail the *sale*.
 *
 * So checkout does one tiny thing: it marks the business dirty. A background
 * tick does the scanning. The first test below is the one that would catch a
 * well-meaning future change to that arrangement.
 *
 * The rest cover the properties that make the job trustworthy rather than
 * merely present: it debounces so a rush is one scan and not two hundred; it
 * rescores on the calendar even with no activity, because recency decays
 * whether or not anyone buys anything; it cannot be claimed twice; it records
 * failures instead of swallowing them; and a run does not discard a change
 * that arrived while it was running.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_rfmfresh_role";
const APP_PASSWORD = "rfm-fresh-password";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let freshness: typeof import("../src/lib/crm-scoring-freshness");

const biz = { id: "", locationId: "" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_rfmfresh_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(databaseName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  freshness = await import("../src/lib/crm-scoring-freshness");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry)
     VALUES ('فروشگاه تست', $1, 'food_service') RETURNING id`,
    [`rfm-${randomUUID().slice(0, 8)}`],
  );
  biz.id = business.rows[0].id;
  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz.id],
  );
  biz.locationId = location.rows[0].id;
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query(`DELETE FROM business_service_activations WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM crm_scoring_state WHERE business_id = $1`, [biz.id]);
  await db.query(`DELETE FROM parties WHERE business_id = $1`, [biz.id]);
});

async function state() {
  const { rows } = await db.query<{
    dirty_since: Date | null;
    last_run_at: Date | null;
    last_run_status: string;
    last_error: string;
    last_scored_count: number;
    running_since: Date | null;
  }>(`SELECT * FROM crm_scoring_state WHERE business_id = $1`, [biz.id]);
  return rows[0] ?? null;
}

describe("checkout marks, it does not score", () => {
  it("the payment path contains no call to recomputeRfm", async () => {
    // Source-level, because this is a property of the *shape* of the code, not
    // of one execution. A future change that "helpfully" rescores after a sale
    // would pass every behavioural test in the suite while putting a
    // full-table aggregation on the path of taking money.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../src/lib/payment-service.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/recomputeRfm/);
    expect(source).not.toMatch(/scorePopulation/);
    // What it should do instead.
    expect(source).toMatch(/markScoringDirtyIn/);
  });

  it("marking dirty is a single upsert and survives repetition", async () => {
    await freshness.markScoringDirty(biz.id);
    const first = await state();
    expect(first?.dirty_since).not.toBeNull();

    // A lunch rush marks the same business on every order. dirty_since must
    // stay at the FIRST divergence — if each order pushed it forward, the
    // debounce would never elapse and the business would never be scored while
    // it was busy, which is precisely when its data is changing.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await freshness.markScoringDirty(biz.id);
    await freshness.markScoringDirty(biz.id);
    const after = await state();
    expect(after?.dirty_since?.getTime()).toBe(first?.dirty_since?.getTime());
  });
});

describe("the tick picks the right businesses", () => {
  it("scores a business that has never been scored", async () => {
    // No state row at all. This is the most-due case there is, and an inner
    // join would silently skip it forever — the business that most needs
    // scoring would be the one that never got it.
    expect(await state()).toBeNull();

    const scored = await freshness.runCrmScoringTick();
    expect(scored).toBeGreaterThanOrEqual(1);

    const after = await state();
    expect(after?.last_run_status).toBe("ok");
    expect(after?.last_run_at).not.toBeNull();
    expect(after?.running_since).toBeNull();
  });

  it("does not claim or clear dirty scores while CRM is customer-disabled", async () => {
    await freshness.markScoringDirty(biz.id);
    await db.query(
      `UPDATE crm_scoring_state SET dirty_since = now() - interval '30 minutes' WHERE business_id = $1`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO business_service_activations
         (business_id, service_kind, service_key, state, disabled_reason)
       VALUES ($1, 'app', 'crm', 'disabled_retained', 'customer')`,
      [biz.id],
    );

    expect(await freshness.runCrmScoringTick()).toBe(0);
    const after = await state();
    expect(after?.dirty_since).not.toBeNull();
    expect(after?.last_run_status).toBe("idle");
    expect(after?.last_run_at).toBeNull();
  });

  it("leaves a freshly-dirtied business alone until the debounce elapses", async () => {
    // Score it once so it is not due on age.
    await freshness.runCrmScoringTick();
    const baseline = await state();

    // Dirty *now* — an order that just happened. The rush may still be going,
    // so the tick should wait rather than scan mid-rush and scan again after.
    await freshness.markScoringDirty(biz.id);
    await freshness.runCrmScoringTick();

    const after = await state();
    expect(after?.last_run_at?.getTime()).toBe(baseline?.last_run_at?.getTime());
    expect(after?.dirty_since).not.toBeNull();
  });

  it("scores a business whose dirty mark has aged past the debounce", async () => {
    await freshness.runCrmScoringTick();
    const baseline = await state();

    await db.query(
      `UPDATE crm_scoring_state SET dirty_since = now() - interval '30 minutes'
        WHERE business_id = $1`,
      [biz.id],
    );

    await freshness.runCrmScoringTick();
    const after = await state();
    expect(after?.last_run_at?.getTime()).toBeGreaterThan(baseline?.last_run_at?.getTime() ?? 0);
    // Satisfied, so cleared.
    expect(after?.dirty_since).toBeNull();
  });

  it("rescores on the calendar even when nothing has changed", async () => {
    await freshness.runCrmScoringTick();
    const baseline = await state();

    // No dirty mark at all — nobody bought anything. Recency still decays: a
    // customer who last visited in Farvardin drifts toward «در خطر» with every
    // day that passes, and no order will ever arrive to signal it. A shop
    // closed for Nowruz must not reopen to scores frozen at the moment it shut.
    await db.query(
      `UPDATE crm_scoring_state SET last_run_at = now() - interval '2 days', dirty_since = NULL
        WHERE business_id = $1`,
      [biz.id],
    );

    await freshness.runCrmScoringTick();
    const after = await state();
    expect(after?.last_run_at?.getTime()).toBeGreaterThan(baseline?.last_run_at?.getTime() ?? 0);
  });

  it("skips a business another worker is already scoring", async () => {
    await freshness.runCrmScoringTick();
    const baseline = await state();

    await db.query(
      `UPDATE crm_scoring_state
          SET dirty_since = now() - interval '30 minutes', running_since = now(),
              last_run_status = 'running'
        WHERE business_id = $1`,
      [biz.id],
    );

    await freshness.runCrmScoringTick();
    const after = await state();
    // Untouched: the other worker owns it.
    expect(after?.last_run_at?.getTime()).toBe(baseline?.last_run_at?.getTime());
  });

  it("reclaims a run that died holding the flag", async () => {
    await freshness.runCrmScoringTick();
    const baseline = await state();

    // A process killed mid-run leaves running_since set. Without reclamation
    // that business would never be scored again — a permanent silent outage
    // for one tenant.
    await db.query(
      `UPDATE crm_scoring_state
          SET dirty_since = now() - interval '30 minutes',
              running_since = now() - interval '3 hours',
              last_run_status = 'running'
        WHERE business_id = $1`,
      [biz.id],
    );

    await freshness.runCrmScoringTick();
    const after = await state();
    expect(after?.last_run_at?.getTime()).toBeGreaterThan(baseline?.last_run_at?.getTime() ?? 0);
    expect(after?.running_since).toBeNull();
    expect(after?.last_run_status).toBe("ok");
  });
});

describe("a run does not lose a change that arrived while it was running", () => {
  it("clears dirt the run accounted for", async () => {
    await freshness.runCrmScoringTick();
    await db.query(
      `UPDATE crm_scoring_state SET dirty_since = now() - interval '30 minutes'
        WHERE business_id = $1`,
      [biz.id],
    );

    // The run started now, so a mark from thirty minutes ago is inside what it
    // scanned and is satisfied.
    await freshness.recordManualScoringRun(biz.id, 5, new Date());
    expect((await state())?.dirty_since).toBeNull();
  });

  it("keeps a dirty mark that arrived after the run started", async () => {
    await freshness.runCrmScoringTick();
    await db.query(
      `UPDATE crm_scoring_state SET dirty_since = now() WHERE business_id = $1`,
      [biz.id],
    );
    const moved = await state();

    // The run began an hour ago; this mark is newer, so it refers to a change
    // the run never saw. Clearing it would lose the signal entirely until the
    // daily floor picked it up hours later.
    await freshness.recordManualScoringRun(
      biz.id,
      5,
      new Date(Date.now() - 60 * 60 * 1000),
    );
    const survived = await state();
    expect(survived?.dirty_since?.getTime()).toBe(moved?.dirty_since?.getTime());
  });

  it("clears the flag rather than rescoring forever", async () => {
    // Regression guard. The first version compared the remembered dirty_since
    // for equality. Postgres keeps microseconds and a JS Date keeps
    // milliseconds, so the value never matched what came back, the flag was
    // never cleared, and the business would have been rescored on every tick
    // for the rest of time — a silent, permanent, expensive no-op loop.
    await freshness.markScoringDirty(biz.id);
    await db.query(
      `UPDATE crm_scoring_state SET dirty_since = now() - interval '30 minutes'
        WHERE business_id = $1`,
      [biz.id],
    );

    await freshness.runCrmScoringTick();
    expect((await state())?.dirty_since).toBeNull();

    // And the next tick therefore finds nothing to do.
    const baseline = await state();
    await freshness.runCrmScoringTick();
    expect((await state())?.last_run_at?.getTime()).toBe(baseline?.last_run_at?.getTime());
  });
});

describe("freshness is reported honestly", () => {
  it("reports 'never scored' rather than a zero-hour-old score", async () => {
    const report = await freshness.scoringFreshness(biz.id);
    // The distinction the UI depends on: null age means «هنوز محاسبه نشده».
    // Zero would read as "scored just now", which is the opposite of the truth.
    expect(report.ageHours).toBeNull();
    expect(report.lastRunAt).toBeNull();
    expect(report.lastRunStatus).toBe("idle");
    expect(report.dirty).toBe(false);
  });

  it("surfaces a failure instead of swallowing it", async () => {
    await db.query(
      `INSERT INTO crm_scoring_state (business_id, last_run_status, last_error, last_run_at)
       VALUES ($1, 'failed', 'connection lost', now())`,
      [biz.id],
    );
    const report = await freshness.scoringFreshness(biz.id);
    // Scores that quietly stopped updating three weeks ago are worse than no
    // scores at all, because people keep making decisions on them.
    expect(report.lastRunStatus).toBe("failed");
    expect(report.lastError).toBe("connection lost");
  });

  it("reports the age of the numbers in whole hours", async () => {
    await db.query(
      `INSERT INTO crm_scoring_state (business_id, last_run_status, last_run_at, last_scored_count)
       VALUES ($1, 'ok', now() - interval '5 hours', 42)`,
      [biz.id],
    );
    const report = await freshness.scoringFreshness(biz.id);
    expect(report.ageHours).toBe(5);
    expect(report.lastScoredCount).toBe(42);
  });
});
