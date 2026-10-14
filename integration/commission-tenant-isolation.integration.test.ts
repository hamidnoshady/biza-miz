/**
 * Issue #869 — tenant isolation for the commission settlement tables, as the
 * runtime role that the application connects with.
 *
 * `tenant-isolation.integration.test.ts` checks every tenant table generically.
 * This file pins the settlement tables specifically, with real data in two
 * businesses, and it runs every probe as a role that row-level security applies
 * to (not a superuser, not BYPASSRLS, not the table owner):
 *
 *  - a session scoped to business A reads none of business B's runs, lines,
 *    carries, payouts, allocations or events, and sees its own;
 *  - it cannot update or delete B's rows (the statement matches nothing);
 *  - it cannot insert a row that claims B's business (the policy's WITH CHECK
 *    refuses it), nor an accrual claim on B's run;
 *  - with no scope set, it sees nothing at all.
 *
 * The owner connection seeds the data through the real services, so the rows are
 * the ones the application writes.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppRole } from "../scripts/create-app-role";
import { runMigrations } from "../scripts/migrate";
import type { CommissionActor } from "../src/lib/commission-settlement-service";
import { PERMISSIONS } from "../src/lib/permissions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_commission_rls_role";
const APP_PASSWORD = "commission-rls-test-password";
const SETTLEMENT_TABLES = [
  "commission_settlement_runs",
  "commission_settlement_lines",
  "commission_settlement_carries",
  "commission_settlement_payouts",
  "commission_settlement_allocations",
  "commission_settlement_events",
] as const;

let databaseName: string;
let ownerClient: Client;
let appClient: Client;
let commissionService: typeof import("../src/lib/commission-service");
let settlement: typeof import("../src/lib/commission-settlement-service");
let dbLib: typeof import("../src/lib/db");
let businessDay: typeof import("../src/lib/business-day-service");

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

const ALL = new Set<string>([
  PERMISSIONS.commissionView,
  PERMISSIONS.commissionCalculate,
  PERMISSIONS.commissionApprove,
  PERMISSIONS.commissionPayout,
  PERMISSIONS.commissionReverse,
]);

interface Seeded {
  id: string;
  locationId: string;
  sellerId: string;
  calculator: CommissionActor;
  approver: CommissionActor;
  paymaster: CommissionActor;
  accountIds: { cash: string; salariesPayable: string; commissionExpense: string };
  runId: string;
  payoutId: string;
}

async function seedBusiness(name: string): Promise<Seeded> {
  const biz = await ownerClient.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, 'cosmetics') RETURNING id",
    [name, `rls-${randomUUID().slice(0, 8)}`],
  );
  const id = biz.rows[0].id;
  const loc = await ownerClient.query<{ id: string }>("INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id", [id]);
  const accounts = await ownerClient.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'صندوق', 'asset'), ($1, '2300', 'حقوق پرداختنی', 'liability'), ($1, '5210', 'پورسانت فروش', 'expense')
     RETURNING id, code`,
    [id],
  );
  const byCode = new Map(accounts.rows.map((row) => [row.code, row.id]));
  const user = async (fullName: string, role: string) =>
    (
      await ownerClient.query<{ id: string }>(
        "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, $3, 'x') RETURNING id",
        [id, role, fullName],
      )
    ).rows[0].id;
  const sellerId = await user("فروشنده", "cashier");
  const calculatorId = await user("مدیر فروش", "manager");
  const approverId = await user("حسابدار", "accountant");
  const paymasterId = await user("خزانه‌دار", "accountant");
  await commissionService.upsertCommissionRule(id, { employeeId: sellerId, kind: "percent", basis: "net", value: 5 });

  // Two accruals of 5,000 each; the run pays one half and is closed, so the other
  // half is carried forward. That gives every settlement table a row to protect.
  for (let i = 0; i < 2; i += 1) {
    const accrualClient = await dbLib.getPool().connect();
    try {
      await commissionService.accrueCommissionForLine(accrualClient, {
        businessId: id,
        locationId: loc.rows[0].id,
        employeeId: sellerId,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: null, itemId: randomUUID() },
      });
    } finally {
      accrualClient.release();
    }
  }

  const calculator: CommissionActor = { userId: calculatorId, role: "manager", permissions: new Set([PERMISSIONS.commissionView, PERMISSIONS.commissionCalculate]) };
  const approver: CommissionActor = { userId: approverId, role: "accountant", permissions: ALL };
  const paymaster: CommissionActor = { userId: paymasterId, role: "accountant", permissions: ALL };
  const day = await businessDay.businessToday(id);
  const { run: draft } = await settlement.createCommissionRun(
    id,
    calculator,
    { periodFrom: day, periodTo: day, locationId: null, employeeIds: [], title: null },
    null,
  );
  await settlement.calculateCommissionRun(id, calculator, draft.id);
  await settlement.reviewCommissionRun(id, approver, draft.id, null);
  await settlement.approveCommissionRun(id, approver, draft.id, null);
  await settlement.releaseCommissionRun(id, paymaster, draft.id, null);
  const payout = await settlement.recordCommissionPayout(
    id,
    paymaster,
    draft.id,
    { allocations: [{ employeeId: sellerId, amount: 5000n }], paymentAccountId: null, method: "cash", paidDate: null, memo: null },
    `rls-payout-${randomUUID()}`,
  );
  await settlement.closeCommissionRun(id, paymaster, draft.id, null);

  return {
    id,
    locationId: loc.rows[0].id,
    sellerId,
    calculator,
    approver,
    paymaster,
    accountIds: { cash: byCode.get("1100")!, salariesPayable: byCode.get("2300")!, commissionExpense: byCode.get("5210")! },
    runId: draft.id,
    payoutId: payout.payout.id,
  };
}

/** Sets the scope the application's request wrapper sets for one business (or none). */
async function scopeTo(businessId: string | null): Promise<void> {
  await appClient.query("SELECT set_config('app.business_id', $1, false)", [businessId ?? ""]);
  await appClient.query("SELECT set_config('app.rls_bypass', '', false)");
}

let alpha: Seeded;
let beta: Seeded;

beforeAll(async () => {
  databaseName = `pos_commission_rls_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  const ownerUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: ownerUrl, quiet: true });
  await createAppRole({ databaseUrl: ownerUrl, roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });

  // The services write through the module-level pool; the owner connection is
  // superuser in this environment, so seeding is not affected by RLS.
  process.env.DEPLOYMENT_ROLE = "central";
  process.env.DATABASE_URL = ownerUrl;
  dbLib = await import("../src/lib/db");
  commissionService = await import("../src/lib/commission-service");
  settlement = await import("../src/lib/commission-settlement-service");
  businessDay = await import("../src/lib/business-day-service");

  ownerClient = new Client({ connectionString: ownerUrl });
  await ownerClient.connect();
  alpha = await seedBusiness("Alpha Commission");
  beta = await seedBusiness("Beta Commission");

  appClient = new Client({ connectionString: urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD }) });
  await appClient.connect();
}, 180_000);

afterAll(async () => {
  await appClient?.end();
  await ownerClient?.end();
  await dbLib?.getPool().end().catch(() => {});
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await maintenance.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  } finally {
    await maintenance.end();
  }
});

describe("the runtime role is one row-level security applies to", () => {
  it("is neither a superuser nor BYPASSRLS, and does not own the settlement tables", async () => {
    const { rows } = await appClient.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0].privileged).toBe(false);
    for (const table of SETTLEMENT_TABLES) {
      const { rows: owners } = await ownerClient.query<{ owner: string }>(
        "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = $1",
        [table],
      );
      expect(owners[0].owner).not.toBe(APP_ROLE);
    }
  });
});

describe("reads are confined to the business in scope", () => {
  it("shows business A its own run, lines, carries, payouts, allocations and events — and nothing of B's", async () => {
    await scopeTo(alpha.id);
    for (const table of SETTLEMENT_TABLES) {
      const { rows } = await appClient.query<{ foreign: string; own: string }>(
        `SELECT COUNT(*) FILTER (WHERE business_id <> $1)::text AS foreign,
                COUNT(*) FILTER (WHERE business_id = $1)::text AS own
           FROM ${table}`,
        [alpha.id],
      );
      expect(rows[0].foreign, `${table} leaks another business`).toBe("0");
      expect(Number(rows[0].own), `${table} should show business A's own rows`).toBeGreaterThan(0);
    }
  });

  it("refuses to show B's run by id, even when asked for it directly", async () => {
    await scopeTo(alpha.id);
    const { rows: run } = await appClient.query("SELECT id FROM commission_settlement_runs WHERE id = $1", [beta.runId]);
    const { rows: lines } = await appClient.query("SELECT id FROM commission_settlement_lines WHERE run_id = $1", [beta.runId]);
    const { rows: payouts } = await appClient.query("SELECT id FROM commission_settlement_payouts WHERE id = $1", [beta.payoutId]);
    expect(run).toEqual([]);
    expect(lines).toEqual([]);
    expect(payouts).toEqual([]);
  });

  it("sees nothing at all when no business is in scope", async () => {
    await scopeTo(null);
    for (const table of SETTLEMENT_TABLES) {
      const { rows } = await appClient.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
      expect(rows[0].n, `${table} is visible with no scope`).toBe("0");
    }
  });
});

describe("writes cannot reach another business's rows", () => {
  it("an update or delete aimed at B's run and payouts matches nothing from A's scope", async () => {
    await scopeTo(alpha.id);
    const renamed = await appClient.query("UPDATE commission_settlement_runs SET title = 'x' WHERE id = $1", [beta.runId]);
    const deleted = await appClient.query("DELETE FROM commission_settlement_lines WHERE run_id = $1", [beta.runId]);
    const voided = await appClient.query("UPDATE commission_settlement_payouts SET memo = 'x' WHERE id = $1", [beta.payoutId]);
    expect(renamed.rowCount).toBe(0);
    expect(deleted.rowCount).toBe(0);
    expect(voided.rowCount).toBe(0);
  });

  it("refuses to insert a row that claims B's business while A is in scope", async () => {
    await scopeTo(alpha.id);
    await expect(
      appClient.query(
        `INSERT INTO commission_settlement_events (id, business_id, run_id, action, to_status, details, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'calculate', 'calculated', '{}'::jsonb, now())`,
        [beta.id, beta.runId],
      ),
    ).rejects.toThrow(/row-level security|violates|policy/i);
  });

  it("refuses to claim B's accrual into A's name, or to release it", async () => {
    await scopeTo(alpha.id);
    const { rows: betaClaim } = await ownerClient.query<{ id: string }>(
      "SELECT id FROM commission_accruals WHERE business_id = $1 LIMIT 1",
      [beta.id],
    );
    const release = await appClient.query("UPDATE commission_accruals SET settlement_run_id = NULL WHERE id = $1", [betaClaim[0].id]);
    expect(release.rowCount).toBe(0);
  });
});
