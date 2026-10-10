/**
 * Issue #869 — commission run approval, settlement and payout, against Postgres.
 *
 * The load-bearing claims, each tested end to end through the real services and
 * the real migrations:
 *
 *  - a run snapshots the unclaimed accruals it settles, and claims them;
 *  - a member whose returns outweigh their sales is held back, not paid;
 *  - the person who calculated a run cannot approve it;
 *  - a payout never exceeds what a member is still owed, a retry is idempotent,
 *    and each payout posts once (Dr 2300 / Cr cash or bank);
 *  - a reversal restores the member's outstanding and mirrors the entry;
 *  - closing a part-paid run carries the balance to the next run, once;
 *  - a reject or void releases the claims; a paid run cannot be voided;
 *  - the database refuses an accrual claimed by both payroll and a run;
 *  - the 2300 tie-out is zero at every step.
 *
 * Every test works in its own business, so the append-only tables (payouts,
 * allocations, events) never need deleting: the file has one database.
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
let businessDay: typeof import("../src/lib/business-day-service");
let payrollService: typeof import("../src/lib/payroll-service");
let ledgerService: typeof import("../src/lib/ledger-service");

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

const previousDeploymentRole = process.env.DEPLOYMENT_ROLE;

beforeAll(async () => {
  // A payout's business-scope sync event is written by the cloud only (#869).
  process.env.DEPLOYMENT_ROLE = "central";
  databaseName = `pos_commission_settle_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  commissionService = await import("../src/lib/commission-service");
  settlement = await import("../src/lib/commission-settlement-service");
  businessDay = await import("../src/lib/business-day-service");
  payrollService = await import("../src/lib/payroll-service");
  ledgerService = await import("../src/lib/ledger-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  if (previousDeploymentRole === undefined) delete process.env.DEPLOYMENT_ROLE;
  else process.env.DEPLOYMENT_ROLE = previousDeploymentRole;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL = new Set<string>([
  PERMISSIONS.commissionView,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);
const CALCULATE_ONLY = new Set<string>([PERMISSIONS.commissionView, PERMISSIONS.commissionCalculate]);

interface Tenant {
  id: string;
  locationId: string;
  accounts: { cash: string; bank: string; salariesPayable: string; commissionExpense: string };
  sellerA: string;
  sellerB: string;
  calculator: CommissionActor;
  approver: CommissionActor;
  paymaster: CommissionActor;
}

async function newTenant(): Promise<Tenant> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Settlement Co', $1, 'cosmetics') RETURNING id",
    [`settle-${randomUUID().slice(0, 8)}`],
  );
  const id = biz.rows[0].id;
  const loc = await db.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [id]);
  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'صندوق', 'asset'), ($1, '1110', 'بانک', 'asset'),
            ($1, '2300', 'حقوق پرداختنی', 'liability'), ($1, '5210', 'پورسانت فروش', 'expense')
     RETURNING id, code`,
    [id],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
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
    accounts: {
      cash: byCode.get("1100")!,
      bank: byCode.get("1110")!,
      salariesPayable: byCode.get("2300")!,
      commissionExpense: byCode.get("5210")!,
    },
    sellerA,
    sellerB,
    calculator: { userId: calculatorId, role: "manager", permissions: CALCULATE_ONLY },
    approver: { userId: approverId, role: "accountant", permissions: ALL },
    paymaster: { userId: paymasterId, role: "accountant", permissions: ALL },
  };
}

async function withClient<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await dbLib.getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** A sale line that accrues commission (5% of the net) for the seller, posted through the real engine. */
async function accrue(tenant: Tenant, employeeId: string, net: number): Promise<void> {
  await withClient((client) =>
    commissionService.accrueCommissionForLine(client, {
      businessId: tenant.id,
      locationId: tenant.locationId,
      employeeId,
      sourceType: "order_item",
      sourceId: randomUUID(),
      line: { net, cost: null, itemId: randomUUID() },
    }),
  );
}

/**
 * A sale return, as the return path writes it: a negative accrual that reverses
 * the commission, with the journal entry that reverses the liability (Dr 2300,
 * Cr 5210), so the ledger and the sub-ledger move together.
 */
async function giveBack(tenant: Tenant, employeeId: string, amount: number): Promise<void> {
  await withClient(async (client) => {
    const entryId = await ledgerService.postExactJournalEntry(client, {
      businessId: tenant.id,
      locationId: tenant.locationId,
      entryDate: null,
      memo: "برگشت پورسانت",
      sourceType: "serial_return",
      sourceId: randomUUID(),
      createdBy: null,
      lines: [
        { accountId: tenant.accounts.salariesPayable, debit: String(amount) as never, credit: "0" as never },
        { accountId: tenant.accounts.commissionExpense, debit: "0" as never, credit: String(amount) as never },
      ],
    });
    await client.query(
      `INSERT INTO commission_accruals (business_id, employee_id, source_type, source_id, amount, basis_amount, entry_id)
       VALUES ($1, $2, 'serial_return', $3, $4, 0, $5)`,
      [tenant.id, employeeId, randomUUID(), -amount, entryId],
    );
  });
}

async function today(tenant: Tenant): Promise<string> {
  return businessDay.businessToday(tenant.id);
}

async function newRun(tenant: Tenant, employeeIds: string[] = [], title: string | null = null) {
  const { run } = await settlement.createCommissionRun(
    tenant.id,
    tenant.calculator,
    { periodFrom: await today(tenant), periodTo: await today(tenant), locationId: null, employeeIds, title },
    null,
  );
  return run;
}

async function approvedRun(tenant: Tenant, employeeIds: string[] = []) {
  const draft = await newRun(tenant, employeeIds);
  await settlement.calculateCommissionRun(tenant.id, tenant.calculator, draft.id);
  await settlement.reviewCommissionRun(tenant.id, tenant.approver, draft.id, null);
  await settlement.approveCommissionRun(tenant.id, tenant.approver, draft.id, null);
  return settlement.releaseCommissionRun(tenant.id, tenant.paymaster, draft.id, null);
}

async function tieOut(tenant: Tenant) {
  return settlement.getCommissionLiability(tenant.id);
}

/** The audit actions written against one run or payout, oldest first. */
async function auditTrail(tenant: Tenant, entityId: string): Promise<string[]> {
  const { rows } = await db.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE business_id = $1 AND entity_id = $2 ORDER BY id",
    [tenant.id, entityId],
  );
  return rows.map((row) => row.action);
}

async function expectRefusal(promise: Promise<unknown>, code: string, status?: number) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as { message: string; status?: number },
  );
  expect(err, `expected refusal ${code}`).not.toBeNull();
  expect(err!.message).toBe(code);
  if (status !== undefined) expect(err!.status).toBe(status);
}

/** A write the database itself must refuse: the message names the guard that fired. */
async function expectDbRefusal(promise: Promise<unknown>, messageFragment: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err, `expected the database to refuse a write containing "${messageFragment}"`).not.toBeNull();
  expect(err!.message).toContain(messageFragment);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("calculating a run", () => {
  it("snapshots the unclaimed accruals it settles, claims them, and holds back a balance that is not positive", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    await accrue(t, t.sellerB, 200_000); // 10,000
    await giveBack(t, t.sellerB, 10_000); // B's return nets them to zero

    const run = await calculateNewRun(t);

    expect(run.status).toBe("calculated");
    expect(run.commissionTotal).toBe("5000");
    expect(run.employeeCount).toBe(1);
    expect(run.lineCount).toBe(1);
    expect(run.warnings.map((w) => w.code)).toContain("balance_not_positive");

    const claimed = await db.query<{ employee_id: string; settlement_run_id: string | null }>(
      "SELECT employee_id, settlement_run_id FROM commission_accruals WHERE business_id = $1 ORDER BY amount DESC",
      [t.id],
    );
    const aClaim = claimed.rows.find((r) => r.employee_id === t.sellerA);
    expect(aClaim?.settlement_run_id).toBe(run.id);
    for (const row of claimed.rows.filter((r) => r.employee_id === t.sellerB)) {
      expect(row.settlement_run_id).toBeNull();
    }

    const lines = await settlement.listCommissionRunLines(t.id, run.id, { employeeId: null, limit: 50, offset: 0 });
    expect(lines.total).toBe(1);
    expect(lines.lines[0]).toMatchObject({ lineKind: "accrual", employeeName: "فروشنده الف", amount: "5000" });
    expect(lines.lines[0].ruleTerms).toMatchObject({ kind: "percent", basis: "net", value: "5" });
    expect(lines.lines[0].ruleVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("refuses a run that would pay nothing, and leaves it a draft with no claims", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerB, 200_000);
    await giveBack(t, t.sellerB, 10_000);
    const draft = await newRun(t, [t.sellerB]);

    await expectRefusal(settlement.calculateCommissionRun(t.id, t.calculator, draft.id), "nothing_to_settle", 409);
    const after = await settlement.getCommissionRun(t.id, draft.id, ALL);
    expect(after.status).toBe("draft");
    const { rows } = await db.query("SELECT 1 FROM commission_accruals WHERE business_id = $1 AND settlement_run_id IS NOT NULL", [t.id]);
    expect(rows).toHaveLength(0);
  });
});

/**
 * A retail sale as the till writes it: a completed retail order whose seller is
 * `opened_by`, with its lines. Nothing here accrues commission; the sale is what
 * the unmapped-seller warning reads.
 */
async function retailSale(t: Tenant, sellerId: string, lines: { unitPrice: number; quantity: number; status?: string }[]): Promise<void> {
  // Opened first, as the till does: a guard refuses lines on an order that is not open.
  const { rows: [order] } = await db.query<{ id: string }>(
    `INSERT INTO orders (location_id, order_number, type, status, opened_by)
     VALUES ($1, $2, 'retail', 'open', $3) RETURNING id`,
    [t.locationId, Math.floor(Math.random() * 1_000_000_000), sellerId],
  );
  for (const line of lines) {
    await db.query(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price, quantity, status)
       VALUES ($1, $2, 'کالای تست', $3, $4, $5)`,
      [t.locationId, order.id, line.unitPrice, line.quantity, line.status ?? "served"],
    );
  }
  await db.query("UPDATE orders SET status = 'completed', closed_by = $2, closed_at = now() WHERE id = $1", [order.id, sellerId]);
}

async function calculateNewRun(t: Tenant) {
  const draft = await newRun(t);
  return settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
}

describe("warnings about sales the run does not pay", () => {
  it("warns about a seller with sales in the period and no rule in force, and accrues nothing for them", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000, the only commission in the run
    const { rows: [stranger] } = await db.query<{ id: string; full_name: string }>(
      "INSERT INTO users (business_id, role, full_name, pin_hash) SELECT business_id, role, 'فروشندهٔ بی‌قانون', 'x' FROM users WHERE id = $1 RETURNING id, full_name",
      [t.sellerA],
    );
    await retailSale(t, stranger.id, [
      { unitPrice: 1_000_000, quantity: 2 },
      { unitPrice: 500_000, quantity: 1 },
      { unitPrice: 999_999, quantity: 1, status: "voided" }, // a voided line is not a sale
    ]);

    const run = await calculateNewRun(t);

    expect(run.commissionTotal).toBe("5000");
    expect(run.employees.map((e) => e.employeeId)).not.toContain(stranger.id);
    expect(run.warnings).toContainEqual({
      code: "unmapped_seller",
      lines: 2,
      sellers: [{ employeeId: stranger.id, fullName: stranger.full_name, lines: 2, salesValue: "2500000" }],
    });
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("does not warn about a seller who has a rule, however much they sold", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    await retailSale(t, t.sellerA, [{ unitPrice: 1_000_000, quantity: 1 }]);

    const run = await calculateNewRun(t);

    expect(run.warnings.map((w) => w.code)).not.toContain("unmapped_seller");
  });
});

describe("approval and payout", () => {
  it("refuses the calculator's own approval, and pays in part, refuses an overpayment, replays a retry", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    await accrue(t, t.sellerB, 200_000); // 10,000

    // Someone who may both calculate and approve must still not approve their own run.
    const bothHats = { userId: t.calculator.userId, role: "manager" as const, permissions: ALL };
    const draft = await newRun(t);
    await settlement.calculateCommissionRun(t.id, bothHats, draft.id);
    await settlement.reviewCommissionRun(t.id, t.approver, draft.id, null);
    await expectRefusal(settlement.approveCommissionRun(t.id, bothHats, draft.id, null), "approver_is_calculator", 403);
    await settlement.approveCommissionRun(t.id, t.approver, draft.id, null);
    const payable = await settlement.releaseCommissionRun(t.id, t.paymaster, draft.id, null);
    expect(payable.status).toBe("payable");
    expect(payable.commissionTotal).toBe("15000");

    const first = await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      draft.id,
      { allocations: [{ employeeId: t.sellerA, amount: 2000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-first-0001",
    );
    expect(first.replayed).toBe(false);
    expect(first.run.status).toBe("partially_paid");
    expect(first.run.paidTotal).toBe("2000");
    expect(first.run.outstandingTotal).toBe("13000");

    // A's outstanding is now 3,000: 4,000 is refused, and nothing is written.
    await expectRefusal(
      settlement.recordCommissionPayout(
        t.id,
        t.paymaster,
        draft.id,
        { allocations: [{ employeeId: t.sellerA, amount: 4000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
        "payout-over-0001",
      ),
      "allocation_exceeds_outstanding",
      409,
    );

    // The same key with the same request replays the payout it made …
    const replay = await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      draft.id,
      { allocations: [{ employeeId: t.sellerA, amount: 2000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-first-0001",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.payout.id).toBe(first.payout.id);
    // … and a different request under the same key is a conflict, not a second payment.
    await expectRefusal(
      settlement.recordCommissionPayout(
        t.id,
        t.paymaster,
        draft.id,
        { allocations: [{ employeeId: t.sellerB, amount: 1000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
        "payout-first-0001",
      ),
      "idempotency_key_conflict",
      409,
    );

    const rest = await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      draft.id,
      {
        allocations: [
          { employeeId: t.sellerA, amount: 3000n },
          { employeeId: t.sellerB, amount: 10000n },
        ],
        paymentAccountId: null,
        method: "bank",
        paidDate: null,
        memo: null,
      },
      "payout-second-0002",
    );
    expect(rest.run.status).toBe("paid");
    expect(rest.run.outstandingTotal).toBe("0");

    // Each payout posted once, balanced, Dr 2300 / Cr the account it left by.
    const { rows: entries } = await db.query<{ source_type: string; posting_kind: string; debit: string; credit: string; account_id: string }>(
      `SELECT je.source_type, je.posting_kind, jl.debit::text AS debit, jl.credit::text AS credit, jl.account_id
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.business_id = $1 AND je.source_type = 'commission_payout' AND je.source_id = $2
        ORDER BY jl.debit DESC`,
      [t.id, first.payout.id],
    );
    expect(entries).toEqual([
      { source_type: "commission_payout", posting_kind: "commission_payout", debit: "2000", credit: "0", account_id: t.accounts.salariesPayable },
      { source_type: "commission_payout", posting_kind: "commission_payout", debit: "0", credit: "2000", account_id: t.accounts.cash },
    ]);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0", paidTotal: "15000" });

    // Approval and payment are separate, audited actions: each leaves its own row, and a refused
    // attempt (the self-approval, the overpayment, the conflicting retry) leaves none.
    expect(await auditTrail(t, draft.id)).toEqual([
      "commission.run.created",
      "commission.run.calculated",
      "commission.run.reviewed",
      "commission.run.approved",
      "commission.run.released",
    ]);
    expect(await auditTrail(t, first.payout.id)).toEqual(["commission.payout.recorded"]);
    expect(await auditTrail(t, rest.payout.id)).toEqual(["commission.payout.recorded"]);
  });

  it("reverses a payout: the member's outstanding returns, the entry is mirrored, and the reversal happens once", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const run = await approvedRun(t);
    const payout = await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      run.id,
      { allocations: [{ employeeId: t.sellerA, amount: 5000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-reverse-0001",
    );
    expect(payout.run.status).toBe("paid");

    const reversed = await settlement.reverseCommissionPayout(t.id, t.paymaster, payout.payout.id, "اشتباه در مبلغ");
    expect(reversed.run.status).toBe("payable");
    expect(reversed.run.paidTotal).toBe("0");
    expect(reversed.run.outstandingTotal).toBe("5000");
    expect(reversed.reversal.kind).toBe("reversal");
    expect(reversed.reversal.allocations).toEqual([expect.objectContaining({ employeeId: t.sellerA, amount: "-5000" })]);

    const { rows: mirrors } = await db.query<{ source_type: string }>(
      "SELECT source_type FROM journal_entries WHERE business_id = $1 AND source_type = 'commission_payout_reversal'",
      [t.id],
    );
    expect(mirrors).toHaveLength(1);
    const { rows: original } = await db.query<{ reversed_at: string | null }>(
      "SELECT reversed_at FROM journal_entries WHERE id = $1",
      [payout.payout.entryId],
    );
    expect(original[0].reversed_at).not.toBeNull();
    expect(await auditTrail(t, payout.payout.id)).toEqual(["commission.payout.recorded"]);
    expect(await auditTrail(t, reversed.reversal.id)).toEqual(["commission.payout.reversed"]);

    const again = await settlement.reverseCommissionPayout(t.id, t.paymaster, payout.payout.id, null);
    expect(again.replayed).toBe(true);
    expect(again.reversal.id).toBe(reversed.reversal.id);
    await expectRefusal(settlement.reverseCommissionPayout(t.id, t.paymaster, reversed.reversal.id, null), "payout_not_reversible", 409);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("refuses a payment dated in the future and a payment made from an account that is not a payment account", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    const run = await approvedRun(t);
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await expectRefusal(
      settlement.recordCommissionPayout(
        t.id,
        t.paymaster,
        run.id,
        { allocations: [{ employeeId: t.sellerA, amount: 100n }], paymentAccountId: null, method: "cash", paidDate: future, memo: null },
        "payout-future-0001",
      ),
      "paid_date_in_future",
      400,
    );
    await expectRefusal(
      settlement.recordCommissionPayout(
        t.id,
        t.paymaster,
        run.id,
        { allocations: [{ employeeId: t.sellerA, amount: 100n }], paymentAccountId: t.accounts.salariesPayable, method: null, paidDate: null, memo: null },
        "payout-account-0001",
      ),
      "invalid_payment_account",
      400,
    );
  });
});

describe("closing, carrying forward, rejecting and voiding", () => {
  it("closing a part-paid run carries what is owed to the next run, which claims it exactly once", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    await accrue(t, t.sellerB, 200_000); // 10,000
    const first = await approvedRun(t);
    await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      first.id,
      {
        allocations: [
          { employeeId: t.sellerA, amount: 5000n },
          { employeeId: t.sellerB, amount: 4000n },
        ],
        paymentAccountId: null,
        method: "cash",
        paidDate: null,
        memo: null,
      },
      "payout-carry-0001",
    );
    const closed = await settlement.closeCommissionRun(t.id, t.paymaster, first.id, "دورهٔ اول");
    expect(closed.status).toBe("closed");
    expect(closed.outstandingTotal).toBe("0");

    const { rows: carries } = await db.query<{ employee_id: string; amount: string; claimed_by_run_id: string | null }>(
      "SELECT employee_id, amount::text AS amount, claimed_by_run_id FROM commission_settlement_carries WHERE business_id = $1",
      [t.id],
    );
    expect(carries).toEqual([{ employee_id: t.sellerB, amount: "6000", claimed_by_run_id: null }]);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0", carriedForward: "6000" });

    // B earns a little more; the next run pays the carry and the new sale together.
    await accrue(t, t.sellerB, 20_000); // 1,000
    const second = await newRun(t);
    const calculated = await settlement.calculateCommissionRun(t.id, t.calculator, second.id);
    expect(calculated.commissionTotal).toBe("7000");
    const lines = await settlement.listCommissionRunLines(t.id, second.id, { employeeId: t.sellerB, limit: 50, offset: 0 });
    expect(lines.lines.map((line) => line.lineKind).sort()).toEqual(["accrual", "carry_forward"]);
    const carry = lines.lines.find((line) => line.lineKind === "carry_forward")!;
    expect(carry).toMatchObject({ amount: "6000", carriedFromRunId: first.id });
    expect(carry.sourceLabel).toContain(String(first.runNumber));

    const { rows: claimed } = await db.query<{ claimed_by_run_id: string | null }>(
      "SELECT claimed_by_run_id FROM commission_settlement_carries WHERE business_id = $1",
      [t.id],
    );
    expect(claimed.map((row) => row.claimed_by_run_id)).toEqual([second.id]);
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0", carriedForward: "0" });
  });

  it("rejects a calculated run back to draft, releasing its accruals, and voids a run only before it pays", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const draft = await newRun(t, [], "بازگشتی");
    await settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
    const rejected = await settlement.rejectCommissionRun(t.id, t.approver, draft.id, "رقم اشتباه است");
    expect(rejected.status).toBe("draft");
    expect(rejected.lineCount).toBe(0);
    expect(rejected.commissionTotal).toBe("0");
    const { rows: released } = await db.query("SELECT 1 FROM commission_accruals WHERE business_id = $1 AND settlement_run_id IS NOT NULL", [t.id]);
    expect(released).toHaveLength(0);

    // Calculate again, then void it: the claims are released and the run is closed to further action.
    await settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
    const voided = await settlement.voidCommissionRun(t.id, t.calculator, draft.id, "دوره اشتباه ساخته شد");
    expect(voided.status).toBe("voided");
    expect(voided.voidReason).toBe("دوره اشتباه ساخته شد");
    expect(voided.actions).toEqual([]);
    await expectRefusal(settlement.voidCommissionRun(t.id, t.approver, draft.id, "دوباره"), "run_not_voidable", 409);

    // A run that has paid cannot be voided or rejected: money has left, so it has to be reversed first.
    const paid = await approvedRun(t);
    await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      paid.id,
      { allocations: [{ employeeId: t.sellerA, amount: 100n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-void-0001",
    );
    await expectRefusal(settlement.voidCommissionRun(t.id, t.approver, paid.id, "نه"), "run_has_payouts", 409);
    await expectRefusal(settlement.rejectCommissionRun(t.id, t.approver, paid.id, null), "run_has_payouts", 409);
  });

  it("a fully reversed run has still posted money: it cannot be rejected or voided, and its history is kept", async () => {
    // Regression (#869 review): reject and void used to test the NET paid total. Pay
    // and reverse the whole amount and the run is "payable" with nothing paid, so
    // reject deleted the run's snapshot lines and released the accruals, and the
    // posted payout and its journal entry were left pointing at nothing.
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const run = await approvedRun(t);
    const payout = await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      run.id,
      { allocations: [{ employeeId: t.sellerA, amount: 5000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-full-reverse-0001",
    );
    await settlement.reverseCommissionPayout(t.id, t.paymaster, payout.payout.id, "برگشت کامل");

    const after = await settlement.getCommissionRun(t.id, run.id, ALL);
    expect(after.status).toBe("payable");
    expect(after.paidTotal).toBe("0");
    expect(after.actions).toEqual(["pay"]);

    await expectRefusal(settlement.rejectCommissionRun(t.id, t.approver, run.id, null), "run_has_payouts", 409);
    await expectRefusal(settlement.voidCommissionRun(t.id, t.approver, run.id, "نه"), "run_has_payouts", 409);

    // Nothing was undone: the snapshot is still there and still claims its accrual.
    const lines = await settlement.listCommissionRunLines(t.id, run.id, { employeeId: null, limit: 50, offset: 0 });
    expect(lines.total).toBe(1);
    const { rows: claim } = await db.query<{ settlement_run_id: string | null }>(
      "SELECT settlement_run_id FROM commission_accruals WHERE business_id = $1 AND source_type = 'order_item'",
      [t.id],
    );
    expect(claim.map((row) => row.settlement_run_id)).toEqual([run.id]);

    // The database refuses the same undo written directly, bypassing the service.
    await expectDbRefusal(
      db.query("DELETE FROM commission_settlement_lines WHERE run_id = $1", [run.id]),
      "immutable snapshot",
    );
    await expectDbRefusal(
      db.query("UPDATE commission_settlement_runs SET status = 'draft' WHERE id = $1", [run.id]),
      "posted payouts",
    );
    await expectDbRefusal(
      db.query("UPDATE commission_accruals SET settlement_run_id = NULL WHERE business_id = $1 AND settlement_run_id = $2", [t.id, run.id]),
      "posted payouts",
    );
    expect(await tieOut(t)).toMatchObject({ difference: "0", subledgerDifference: "0" });
  });

  it("the database refuses a payout written into a closed run, around the service", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000
    const run = await approvedRun(t);
    await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      run.id,
      { allocations: [{ employeeId: t.sellerA, amount: 5000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-closed-guard-0001",
    );
    const closed = await settlement.closeCommissionRun(t.id, t.paymaster, run.id, null);
    expect(closed.status).toBe("closed");

    await expectDbRefusal(
      db.query(
        `INSERT INTO commission_settlement_payouts (business_id, run_id, kind, amount, payment_method, idempotency_key, request_hash)
         VALUES ($1, $2, 'payout', 1, 'cash', 'direct-write-guard-01', 'x')`,
        [t.id, run.id],
      ),
      "a payout can only be posted to a payable run",
    );
  });

  it("requires the permission for each action, and a run cannot skip a step", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    const draft = await newRun(t);
    // The calculator may not approve, and nothing may be released before it is approved.
    await expectRefusal(settlement.releaseCommissionRun(t.id, t.paymaster, draft.id, null), "run_not_approved", 409);
    await settlement.calculateCommissionRun(t.id, t.calculator, draft.id);
    await expectRefusal(settlement.approveCommissionRun(t.id, t.approver, draft.id, null), "run_not_reviewed", 409);
    await expectRefusal(settlement.reviewCommissionRun(t.id, t.calculator, draft.id, null), "permission_required", 403);
  });
});

describe("the database keeps payroll and settlement from claiming the same accrual", () => {
  it("refuses a second claim on an accrual that a settlement run already holds", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    const run = await calculateNewRun(t);
    expect(run.commissionTotal).toBe("5000");

    const { rows: [claimed] } = await db.query<{ id: string }>(
      "SELECT id FROM commission_accruals WHERE business_id = $1 AND settlement_run_id = $2",
      [t.id, run.id],
    );
    const { rows: [payroll] } = await db.query<{ id: string }>(
      "INSERT INTO payroll_runs (business_id, period_label, total_amount) VALUES ($1, 'تست', 1000) RETURNING id",
      [t.id],
    );
    await expect(
      db.query("UPDATE commission_accruals SET payroll_run_id = $1 WHERE id = $2", [payroll.id, claimed.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("leaves a row claimed by payroll out of a settlement run, and the tie-out agrees with payroll's own", async () => {
    const t = await newTenant();
    await accrue(t, t.sellerA, 100_000); // 5,000, to be claimed by payroll
    await accrue(t, t.sellerB, 200_000); // 10,000, left for the run
    const { rows: [payroll] } = await db.query<{ id: string }>(
      "INSERT INTO payroll_runs (business_id, period_label, total_amount) VALUES ($1, 'تست', 1000) RETURNING id",
      [t.id],
    );
    await db.query(
      "UPDATE commission_accruals SET payroll_run_id = $1 WHERE business_id = $2 AND employee_id = $3",
      [payroll.id, t.id, t.sellerA],
    );

    const run = await calculateNewRun(t);
    expect(run.commissionTotal).toBe("10000");
    expect(run.warnings).toContainEqual({
      code: "claimed_by_payroll",
      rows: 1,
      payrolls: [{ payrollRunId: payroll.id, periodLabel: "تست", rows: 1 }],
    });
    expect(run.employeeCount).toBe(1);
    expect(run.warnings.map((w) => w.code)).toContain("claimed_by_payroll");

    // Payroll's liability tie-out counts the standalone position as unsettled, so it still reconciles.
    const liability = await payrollService.getPayrollLiability(t.id);
    expect(liability.unsettledCommission).toBe("10000");
  });
});

describe("reads and isolation", () => {
  it("lists runs with their totals, gives a member their statement, and shows another business nothing", async () => {
    const t = await newTenant();
    const other = await newTenant();
    await accrue(t, t.sellerA, 100_000);
    const run = await approvedRun(t);
    await settlement.recordCommissionPayout(
      t.id,
      t.paymaster,
      run.id,
      { allocations: [{ employeeId: t.sellerA, amount: 2000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
      "payout-read-0001",
    );

    const page = await settlement.listCommissionRuns(t.id, { status: null, limit: 10, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.runs[0]).toMatchObject({ id: run.id, status: "partially_paid", paidTotal: "2000", outstandingTotal: "3000" });

    const statement = await settlement.getCommissionStatement(t.id, t.sellerA);
    expect(statement.totals).toEqual({ accrued: "5000", paidThroughPayroll: "0", paidThroughRuns: "2000", unpaid: "3000" });
    expect(statement.payouts).toEqual([expect.objectContaining({ kind: "payout", amount: "2000" })]);

    expect((await settlement.listCommissionRuns(other.id, { status: null, limit: 10, offset: 0 })).total).toBe(0);
    await expectRefusal(settlement.getCommissionRun(other.id, run.id, ALL), "run_not_found", 404);
  });

  it("refuses a run for a future period, a member or branch from another business, and an unknown run", async () => {
    const t = await newTenant();
    const other = await newTenant();
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await expectRefusal(
      settlement.createCommissionRun(t.id, t.calculator, { periodFrom: future, periodTo: future, locationId: null, employeeIds: [], title: null }, null),
      "period_in_future",
      400,
    );
    await expectRefusal(
      settlement.createCommissionRun(t.id, t.calculator, { periodFrom: await today(t), periodTo: await today(t), locationId: null, employeeIds: [other.sellerA], title: null }, null),
      "employee_not_found",
      400,
    );
    await expectRefusal(settlement.calculateCommissionRun(t.id, t.calculator, randomUUID()), "run_not_found", 404);
  });
});
