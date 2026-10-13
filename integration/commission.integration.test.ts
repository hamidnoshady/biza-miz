/**
 * Phase 27 Wave 7 — sales-staff commission is a payroll liability, not a
 * report-only number.
 *
 * The load-bearing claims: a settled line accrues commission to the selling
 * employee per the most specific matching rule, and the accrual posts Debit
 * «پورسانت فروش» (5210) / Credit «حقوق پرداختنی» (2300) through the domain
 * engine. A margin-basis rule uses the same cost the COGS posting used, and
 * the per-staff report is a SUM of the signed accruals.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let commissionService: typeof import("../src/lib/commission-service");

const biz = { id: "", locationId: "" };
const acct = { commissionExpense: "", salariesPayable: "" };
const employee = { id: "" };

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

beforeAll(async () => {
  databaseName = `pos_commission_${randomUUID().replaceAll("-", "")}`;

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

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

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
  await db.query("DELETE FROM commission_accruals");
  await db.query("DELETE FROM commission_rules");
  // Closed-order trigger guards child writes, and a cascade may otherwise
  // reach an order item after its parent has already disappeared.
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM domain_events");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounts");
  await db.query("DELETE FROM users");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Commission Co', $1, 'cosmetics') RETURNING id",
    [`commission-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const empRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', 'فروشنده نمونه', 'x') RETURNING id`,
    [biz.id],
  );
  employee.id = empRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5210', 'Commission expense', 'expense'), ($1, '2300', 'Salaries payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "5210") acct.commissionExpense = row.id;
    if (row.code === "2300") acct.salariesPayable = row.id;
  }
});

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

describe("commission accrual", () => {
  it("filters the leaderboard to the requested branch while retaining the central all-branch view", async () => {
    const otherLocation = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Second') RETURNING id",
      [biz.id],
    );
    const firstOrder = await db.query<{ id: string }>(
      "INSERT INTO orders (location_id, order_number) VALUES ($1, 1) RETURNING id",
      [biz.locationId],
    );
    const secondOrder = await db.query<{ id: string }>(
      "INSERT INTO orders (location_id, order_number) VALUES ($1, 1) RETURNING id",
      [otherLocation.rows[0].id],
    );
    const firstLine = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price)
       VALUES ($1, $2, 'Branch one', 10000) RETURNING id`,
      [biz.locationId, firstOrder.rows[0].id],
    );
    const secondLine = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, unit_price)
       VALUES ($1, $2, 'Branch two', 20000) RETURNING id`,
      [otherLocation.rows[0].id, secondOrder.rows[0].id],
    );
    await db.query(
      `INSERT INTO commission_accruals (business_id, employee_id, source_type, source_id, amount, basis_amount)
       VALUES ($1, $2, 'order_item', $3, 500, 10000), ($1, $2, 'order_item', $4, 900, 20000)`,
      [biz.id, employee.id, firstLine.rows[0].id, secondLine.rows[0].id],
    );

    const branchReport = await commissionService.staffCommissionReport(biz.id, undefined, biz.locationId);
    expect(branchReport).toHaveLength(1);
    expect(branchReport[0]).toMatchObject({ amount: 500, basisAmount: 10000, lineCount: 1 });

    const businessReport = await commissionService.staffCommissionReport(biz.id);
    expect(businessReport).toHaveLength(1);
    expect(businessReport[0]).toMatchObject({ amount: 1400, basisAmount: 30000, lineCount: 2 });
  });

  it("accrues a percent of net and posts the payroll liability", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    // 5% of 100,000 = 5,000, posted Debit 5210 / Credit 2300.
    const entry = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'commission.accrued'",
    );
    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entry.rows[0].entry_id],
    );
    expect(lines).toEqual([
      { account_id: acct.commissionExpense, debit: "5000", credit: "0" },
      { account_id: acct.salariesPayable, debit: "0", credit: "5000" },
    ]);

    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(1);
    expect(report[0].employeeName).toBe("فروشنده نمونه");
    expect(report[0].amount).toBe(5000);
    expect(report[0].lineCount).toBe(1);
  });

  it("computes a margin-basis rule on net minus cost", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "margin",
      value: 10,
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    // 10% of (100,000 − 40,000) = 6,000.
    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].amount).toBe(6000);
    expect(report[0].basisAmount).toBe(60_000);
  });

  it("accrues nothing when no rule matches the selling employee", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
      itemIds: [randomUUID()],
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        // A different item than the rule scopes.
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(0);
  });

  it("picks the most specific matching rule", async () => {
    const itemId = randomUUID();
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 2,
    });
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 7,
      itemIds: [itemId],
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 0, itemId },
      }),
    );

    // The item-scoped 7% beats the catch-all 2%.
    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].amount).toBe(7000);
  });

  it("stamps the accrual row with the journal entry its domain event posted", async () => {
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 40_000, itemId: randomUUID() },
      }),
    );

    // commission_accruals.entry_id is the join to the payroll liability —
    // it used to stay NULL, and the tie-out had to be re-derived by hand.
    const { rows } = await db.query<{ entry_id: string | null }>(
      "SELECT entry_id FROM commission_accruals",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].entry_id).not.toBeNull();

    const event = await db.query<{ entry_id: string }>(
      "SELECT entry_id FROM domain_events WHERE event_type = 'commission.accrued'",
    );
    expect(rows[0].entry_id).toBe(event.rows[0].entry_id);
  });

  it("accrues through the category axis when the caller supplies the line's category", async () => {
    const categoryId = randomUUID();
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 8,
      categoryIds: [categoryId],
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        // The categoryId was dropped on the floor before: a category-scoped
        // rule could never match, no matter what the caller knew.
        line: { net: 100_000, cost: 0, itemId: randomUUID(), categoryId },
      }),
    );

    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(1);
    expect(report[0].amount).toBe(8_000);
  });

  it("does not accrue outside a rule's active window", async () => {
    const day = 24 * 60 * 60 * 1000;
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
      activeFrom: iso(Date.now() + 2 * day), // starts the day after tomorrow
    });
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 6,
      activeTo: iso(Date.now() - 2 * day), // ended the day before yesterday
    });
    await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 7,
      activeFrom: iso(Date.now() - 2 * day),
      activeTo: iso(Date.now() + 2 * day),
    });

    await withClient((client) =>
      commissionService.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        employeeId: employee.id,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 100_000, cost: 0, itemId: randomUUID() },
      }),
    );

    // Only the in-window 7% rule may earn; active_from/active_to used to be
    // stored, even editable through the service, and then simply ignored.
    const report = await commissionService.staffCommissionReport(biz.id);
    expect(report).toHaveLength(1);
    expect(report[0].amount).toBe(7_000);
  });

  it("a deactivated rule stops earning but its accruals keep their history", async () => {
    const rule = await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
    });

    const settle = () =>
      withClient((client) =>
        commissionService.accrueCommissionForLine(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          employeeId: employee.id,
          sourceType: "order_item",
          sourceId: randomUUID(),
          line: { net: 100_000, cost: 0, itemId: randomUUID() },
        }),
      );

    await settle();
    await commissionService.setCommissionRuleActive(biz.id, rule.id, false);
    await settle();

    let report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].lineCount).toBe(1);
    expect(report[0].amount).toBe(5_000);

    await commissionService.setCommissionRuleActive(biz.id, rule.id, true);
    await settle();
    report = await commissionService.staffCommissionReport(biz.id);
    expect(report[0].lineCount).toBe(2);
    expect(report[0].amount).toBe(10_000);
  });

  it("refuses to toggle a rule that belongs to another business", async () => {
    const rule = await commissionService.upsertCommissionRule(biz.id, {
      employeeId: employee.id,
      kind: "percent",
      basis: "net",
      value: 5,
    });
    const otherBiz = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug) VALUES ('Third', $1) RETURNING id`,
      [`third-${randomUUID().slice(0, 8)}`],
    );

    await expect(
      commissionService.setCommissionRuleActive(otherBiz.rows[0].id, rule.id, false),
    ).rejects.toThrow(/یافت نشد/);

    const after = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM commission_rules WHERE id = $1",
      [rule.id],
    );
    expect(after.rows[0].is_active).toBe(true);
  });

  it("refuses to name an employee from another business", async () => {
    const otherBiz = await db.query<{ id: string }>(
      `INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id`,
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherUser = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Other', 'x') RETURNING id`,
      [otherBiz.rows[0].id],
    );

    await expect(
      commissionService.upsertCommissionRule(biz.id, {
        employeeId: otherUser.rows[0].id,
        kind: "percent",
        basis: "net",
        value: 5,
      }),
    ).rejects.toThrow(/فروشنده/);
  });
});
