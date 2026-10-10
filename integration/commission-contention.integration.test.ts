/**
 * Issue #869 — contention, retries and rollback in the commission settlement
 * path, against Postgres with real concurrent connections.
 *
 * Payroll and settlement share one transaction-scoped advisory lock per business
 * (`lockPayroll`); each run and each payout then takes its own row lock. These
 * tests put two actors on the same rows at the same time and check what the
 * database leaves behind:
 *
 *  - a calculation that is held behind payroll's lock claims only the rows payroll
 *    did not take, and the claim CHECK never sees a row claimed twice (barrier);
 *  - two runs calculated at once cannot both claim the same accrual;
 *  - two payouts for the same outstanding amount cannot both post (no overpayment);
 *  - the same payout key sent twice at once posts once, and the other replays it;
 *  - a payout that fails after its writes leaves no payout, allocation, journal
 *    entry, outbox event or status change behind (rollback).
 *
 * The barrier is deterministic: the test holds the business's payroll lock on its
 * own connection, waits until the calculation is observed blocked on that lock,
 * then makes payroll's change under the lock it holds.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { CommissionActor } from "../src/lib/commission-settlement-service";
import { PERMISSIONS } from "../src/lib/permissions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let commissionService: typeof import("../src/lib/commission-service");
let settlement: typeof import("../src/lib/commission-settlement-service");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

const ALL = new Set<string>([
  PERMISSIONS.commissionView,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);

interface Tenant {
  id: string;
  locationId: string;
  sellerA: string;
  sellerB: string;
  calculator: CommissionActor;
  approver: CommissionActor;
  paymaster: CommissionActor;
}

async function newTenant(): Promise<Tenant> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Contention Co', $1, 'cosmetics') RETURNING id",
    [`contend-${randomUUID().slice(0, 8)}`],
  );
  const id = biz.rows[0].id;
  const loc = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [id]);
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'صندوق', 'asset'), ($1, '1110', 'بانک', 'asset'),
            ($1, '2300', 'حقوق پرداختنی', 'liability'), ($1, '5210', 'پورسانت فروش', 'expense')`,
    [id],
  );
  const user = async (name: string, role: string) =>
    (
      await db.query<{ id: string }>(
        "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, $3, 'x') RETURNING id",
        [id, role, name],
      )
    ).rows[0].id;
  const sellerA = await user("فروشنده الف", "cashier");
  const sellerB = await user("فروشنده ب", "cashier");
  const calculatorId = await user("مدیر فروش", "manager");
  const approverId = await user("حسابدار", "accountant");
  const paymasterId = await user("خزانه‌دار", "accountant");
  for (const sellerId of [sellerA, sellerB]) {
    await commissionService.upsertCommissionRule(id, { employeeId: sellerId, kind: "percent", basis: "net", value: 5 });
  }
  return {
    id,
    locationId: loc.rows[0].id,
    sellerA,
    sellerB,
    calculator: { userId: calculatorId, role: "manager", permissions: new Set([PERMISSIONS.commissionView, PERMISSIONS.commissionCalculate]) },
    approver: { userId: approverId, role: "accountant", permissions: ALL },
    paymaster: { userId: paymasterId, role: "accountant", permissions: ALL },
  };
}

async function accrue(t: Tenant, employeeId: string, net: number): Promise<void> {
  const client = await dbLib.getPool().connect();
  try {
    await commissionService.accrueCommissionForLine(client, {
      businessId: t.id,
      locationId: t.locationId,
      employeeId,
      sourceType: "order_item",
      sourceId: randomUUID(),
      line: { net, cost: null, itemId: randomUUID() },
    });
  } finally {
    client.release();
  }
}

async function newRun(t: Tenant) {
  const day = await businessDay.businessToday(t.id);
  const { run } = await settlement.createCommissionRun(
    t.id,
    t.calculator,
    { periodFrom: day, periodTo: day, locationId: null, employeeIds: [], title: null },
    null,
  );
  return run;
}

async function approvedRun(t: Tenant) {
  const draft = await newRun(t);
  await settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
  await settlement.reviewCommissionRun(t.id, t.approver, draft.id, null);
  await settlement.approveCommissionRun(t.id, t.approver, draft.id, null);
  return settlement.releaseCommissionRun(t.id, t.paymaster, draft.id, null);
}

function payoutFor(t: Tenant, employeeId: string, amount: bigint) {
  return { allocations: [{ employeeId, amount }], paymentAccountId: null, method: "cash" as const, paidDate: null, memo: null };
}

async function tieOut(t: Tenant) {
  return settlement.getCommissionLiability(t.id);
}

let businessDay: typeof import("../src/lib/business-day-service");

beforeAll(async () => {
  databaseName = `pos_commission_contention_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DEPLOYMENT_ROLE = "central";
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  commissionService = await import("../src/lib/commission-service");
  settlement = await import("../src/lib/commission-settlement-service");
  businessDay = await import("../src/lib/business-day-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** Waits until some backend is blocked on the business's payroll advisory lock. */
async function untilBlockedOnPayrollLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%pg_advisory_xact_lock%'`,
    );
    if (rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the calculation never blocked on the payroll lock");
}

describe("calculation against payroll's lock", () => {
  it("a calculation held behind payroll's lock claims only the rows payroll did not take", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000, payroll will take it
    await accrue(t, t.sellerB, 200_000); // 10,000, left for the run
    const draft = await newRun(t);

    const holder = new Client({ connectionString: urlFor(databaseName) });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll:${t.id}`]);

      const calculation = settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
      await untilBlockedOnPayrollLock();

      // Payroll, under the lock it holds, claims seller A's row.
      // Payroll carries the commission it claims as awaiting commission, as the real
      // payroll run does; without it the tie-out would (rightly) report the gap.
      const { rows: [payroll] } = await holder.query<{ id: string }>(
        `INSERT INTO payroll_runs (business_id, period_label, total_amount, net_amount, commission_total)
         VALUES ($1, 'هم‌زمان', 5000, 0, 5000) RETURNING id`,
        [t.id],
      );
      await holder.query(
        "UPDATE commission_accruals SET payroll_run_id = $1 WHERE business_id = $2 AND employee_id = $3",
        [payroll.id, t.id, t.sellerA],
      );
      await holder.query("COMMIT");

      const run = await calculation;
      expect(run.commissionTotal).toBe("10000");
      expect(run.employeeCount).toBe(1);
      expect(run.warnings).toContainEqual({
        code: "claimed_by_payroll",
        rows: 1,
        payrolls: [{ payrollRunId: payroll.id, periodLabel: "هم‌زمان", rows: 1 }],
      });
    } finally {
      await holder.end();
    }

    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM commission_accruals
        WHERE business_id = $1 AND payroll_run_id IS NOT NULL AND settlement_run_id IS NOT NULL`,
      [t.id],
    );
    expect(rows[0].n).toBe(0);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("two runs calculated at the same moment cannot both claim one accrual", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const first = await newRun(t);
    const second = await newRun(t);

    const results = await Promise.allSettled([
      settlement.calculateCommissionRun(t.id, t.calculator, first.id),
      settlement.calculateCommissionRun(t.id, t.calculator, second.id),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as { message: string }).message).toBe("nothing_to_settle");

    const { rows } = await db.query<{ n: number; runs: number }>(
      `SELECT COUNT(*)::int AS n, COUNT(DISTINCT settlement_run_id)::int AS runs
         FROM commission_accruals WHERE business_id = $1 AND settlement_run_id IS NOT NULL`,
      [t.id],
    );
    expect(rows[0]).toEqual({ n: 1, runs: 1 });
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });
});

describe("payouts at the same moment", () => {
  it("two payouts for the same outstanding amount cannot both post: one pays, the other is refused", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const run = await approvedRun(t);

    const results = await Promise.allSettled([
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 5000n), "race-key-aaaa-0001"),
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 5000n), "race-key-bbbb-0002"),
    ]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // Once the first payout pays the run in full it is `paid`, so the second is refused for the state.
    expect(["run_not_payable", "nothing_outstanding", "allocation_exceeds_outstanding"]).toContain(
      (lost[0].reason as { message: string }).message,
    );

    const { rows } = await db.query<{ paid: string; n: number }>(
      "SELECT COALESCE(SUM(amount), 0)::text AS paid, COUNT(*)::int AS n FROM commission_settlement_payouts WHERE run_id = $1 AND kind = 'payout'",
      [run.id],
    );
    expect(rows[0]).toEqual({ paid: "5000", n: 1 });
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("the same payout key sent twice at once posts once, and the second request is a replay", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    const run = await approvedRun(t);
    const key = "same-key-twice-0001";

    const results = await Promise.all([
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 2000n), key),
      settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 2000n), key),
    ]);

    expect(results[0].payout.id).toBe(results[1].payout.id);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    const { rows } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM commission_settlement_payouts WHERE run_id = $1 AND kind = 'payout'",
      [run.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("rollback", () => {
  it("a payout that fails after its writes leaves no payout, journal entry, outbox event or status change", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const run = await approvedRun(t);

    const snapshot = async () => {
      const { rows: [counts] } = await db.query<Record<string, string>>(
        `SELECT
           (SELECT COUNT(*) FROM commission_settlement_payouts WHERE business_id = $1)::text AS payouts,
           (SELECT COUNT(*) FROM commission_settlement_allocations WHERE business_id = $1)::text AS allocations,
           (SELECT COUNT(*) FROM journal_entries WHERE business_id = $1 AND source_type = 'commission_payout')::text AS entries,
           (SELECT COUNT(*) FROM sync_events WHERE business_id = $1 AND event_type = 'commission.payout.recorded')::text AS outbox,
           (SELECT status FROM commission_settlement_runs WHERE id = $2) AS status,
           (SELECT COUNT(*) FROM commission_settlement_events WHERE run_id = $2 AND action = 'payout')::text AS pay_events`,
        [t.id, run.id],
      );
      return counts;
    };
    const before = await snapshot();

    // Fail the payout after its payout row, allocations and journal entry are written.
    await db.query(
      `CREATE FUNCTION injected_payout_failure() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'injected failure after the payout is written'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER injected_payout_failure BEFORE INSERT ON commission_settlement_events
         FOR EACH ROW WHEN (NEW.action = 'payout') EXECUTE FUNCTION injected_payout_failure()`,
    );
    try {
      await expect(
        settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 5000n), "rollback-key-0001"),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await db.query("DROP TRIGGER injected_payout_failure ON commission_settlement_events");
      await db.query("DROP FUNCTION injected_payout_failure()");
    }

    expect(await snapshot()).toEqual(before);
    const after = await settlement.getCommissionRun(t.id, run.id, ALL);
    expect(after.status).toBe("payable");
    expect(after.paidTotal).toBe("0");

    // The same request, retried once the fault is gone, posts exactly once.
    const retry = await settlement.recordCommissionPayout(t.id, t.paymaster, run.id, payoutFor(t, t.sellerA, 5000n), "rollback-key-0001");
    expect(retry.replayed).toBe(false);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });
});
