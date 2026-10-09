/**
 * Issue #865 — the statutory payroll engine, against a real database.
 *
 * Pins: versioned rules and their snapshot; the full workflow
 * draft → calculate → review → approve → post → pay → close; immutability of an
 * approved run and its payslips (DB triggers); supplemental runs on the
 * cumulative month; exact, idempotent posting; month exclusivity with the #835
 * journal-level payroll; advances and commission never settled twice; fiscal
 * locks; and the liability reconciliation tying out to the GL.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let setup: typeof import("../src/lib/payroll-engine-setup");
let runs: typeof import("../src/lib/payroll-engine-runs");
let legacy: typeof import("../src/lib/payroll-service");
let advances: typeof import("../src/lib/payroll-advances-service");
let fiscal: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const owner = { id: "" };
const staff = { a: "", b: "" };

/** A closed month: Mordad 1404 = 2025-07-23 … 2025-08-22. */
const MORDAD = "1404-05";
const SHAHRIVAR = "1404-06";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_payroll_engine_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  setup = await import("../src/lib/payroll-engine-setup");
  runs = await import("../src/lib/payroll-engine-runs");
  legacy = await import("../src/lib/payroll-service");
  advances = await import("../src/lib/payroll-advances-service");
  fiscal = await import("../src/lib/fiscal-periods-service");
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("SELECT set_config('app.rls_bypass', 'on', false)");
  await db.query("DELETE FROM payroll_payslips");
  await db.query("DELETE FROM payroll_engine_runs");
  await db.query("DELETE FROM payroll_employee_items");
  await db.query("DELETE FROM payroll_advances");
  await db.query("DELETE FROM payroll_run_lines");
  await db.query("DELETE FROM payroll_runs");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  biz.id = (await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Engine Co', $1) RETURNING id", [`eng-${randomUUID().slice(0, 8)}`])).rows[0].id;
  owner.id = (await db.query<{ id: string }>(`INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`, [biz.id])).rows[0].id;
  const s = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', 'Ali', 'x'), ($1, 'waiter', 'Sara', 'x') RETURNING id`,
    [biz.id],
  );
  staff.a = s.rows[0].id;
  staff.b = s.rows[1].id;
  await db.query(
    `INSERT INTO accounts (business_id, code, name, type) VALUES
       ($1,'1100','Cash','asset'), ($1,'1110','Bank','asset'), ($1,'1260','Advances','asset'),
       ($1,'2300','Salaries payable','liability'), ($1,'2460','Insurance payable','liability'),
       ($1,'2470','Payroll tax payable','liability'), ($1,'2490','Other deductions','liability'),
       ($1,'5200','Salaries','expense'), ($1,'5220','Employer insurance','expense'), ($1,'5210','Commission','expense')`,
    [biz.id],
  );

  await setup.createRuleSet({
    businessId: biz.id,
    actorId: owner.id,
    title: "قوانین ۱۴۰۴",
    effectiveFrom: "2025-03-21",
    rules: {
      insuranceCeilingRial: 500_000_000,
      taxExemptMonthlyRial: 100_000_000,
      taxBrackets: [{ upToRial: 200_000_000, ratePercent: 10 }, { upToRial: null, ratePercent: 20 }],
    },
  });
  await setup.saveProfile({ businessId: biz.id, actorId: owner.id, userId: staff.a, body: { baseSalary: "150000000", payrollCode: "P-1", costAllocation: [{ percent: 60, label: "شعبه ۱" }, { percent: 40, label: "شعبه ۲" }] } });
  await setup.saveProfile({ businessId: biz.id, actorId: owner.id, userId: staff.b, body: { baseSalary: 90_000_000, insuranceProfile: { insured: false }, taxProfile: { exempt: true } } });
});

const actor = () => ({ businessId: biz.id, actorId: owner.id });

async function approvedRun(overrides: Record<string, unknown> = {}) {
  const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, ...overrides });
  await runs.calculateEngineRun({ ...actor(), runId: run.id });
  await runs.reviewEngineRun({ ...actor(), runId: run.id });
  return runs.approveEngineRun({ ...actor(), runId: run.id });
}

async function balance(code: string): Promise<bigint> {
  const { rows } = await db.query<{ b: string }>(
    `SELECT COALESCE(sum(jl.credit - jl.debit), 0)::text AS b FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE a.business_id = $1 AND a.code = $2`,
    [biz.id, code],
  );
  return BigInt(rows[0].b);
}

describe("payroll engine — workflow", () => {
  it("calculates, approves, posts, pays and closes a month with exact figures", async () => {
    const housing = (await setup.listComponents(biz.id)).find((c) => c.code === "HOUSING")!;
    await setup.addItem({ ...actor(), body: { userId: staff.a, componentId: housing.id, amount: "10000000", effectiveFrom: "2025-01-01" } });

    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, inputs: { [staff.a]: { overtimeHours: 0 } } });
    expect(run.status).toBe("draft");
    const calc = await runs.calculateEngineRun({ ...actor(), runId: run.id });
    expect(calc.status).toBe("calculated");
    expect(calc.ruleSetVersion).toBe(1);

    const slips = await runs.listPayslips(biz.id, run.id);
    const ali = slips.find((s) => s.userId === staff.a)!;
    expect(ali.gross).toBe("160000000");
    expect(ali.employeeInsurance).toBe("11200000");
    expect(ali.incomeTax).toBe(((160_000_000 - 11_200_000 - 100_000_000) / 10).toString());
    expect(ali.costAllocation.map((c) => c.amount).reduce((a, b) => a + BigInt(b), 0n).toString()).toBe(ali.employerCost);
    const sara = slips.find((s) => s.userId === staff.b)!;
    expect(sara.netPay).toBe("90000000");
    expect(sara.employerInsurance).toBe("0");

    await expect(runs.approveEngineRun({ ...actor(), runId: run.id })).rejects.toThrow("invalid_run_transition");
    await runs.reviewEngineRun({ ...actor(), runId: run.id });
    await runs.approveEngineRun({ ...actor(), runId: run.id });

    const posted = await runs.postEngineRun({ ...actor(), runId: run.id });
    expect(posted.status).toBe("posted");
    await expect(runs.postEngineRun({ ...actor(), runId: run.id })).rejects.toThrow("already_posted");
    expect(await balance("2470")).toBe(BigInt(ali.incomeTax));
    expect(await balance("2460")).toBe(11_200_000n + 32_000_000n + 4_800_000n);
    expect(-(await balance("5200"))).toBe(250_000_000n);
    expect(await balance("2300")).toBe(BigInt(ali.netPay) + 90_000_000n);

    const recon = await runs.payrollLiabilityReconciliation(biz.id);
    expect(recon.reconciled).toBe(true);

    await runs.payEngineRun({ ...actor(), runId: run.id, method: "bank", paidDate: "2025-08-25" });
    expect(await balance("2300")).toBe(0n);
    expect((await runs.listPayslips(biz.id, run.id)).every((s) => s.paymentStatus === "paid")).toBe(true);
    expect((await runs.payrollLiabilityReconciliation(biz.id)).reconciled).toBe(true);
    const closed = await runs.closeEngineRun({ ...actor(), runId: run.id });
    expect(closed.status).toBe("closed");

    const register = await runs.payrollRegister(biz.id, { periodKey: MORDAD });
    expect(register.payslips).toHaveLength(2);
    const card = await runs.employeePayrollCard(biz.id, staff.a, 1404);
    expect(card.payslips).toHaveLength(1);
    const ins = await runs.insuranceSummary(biz.id, MORDAD);
    expect(ins.totals?.totalInsurance).toBe("48000000");
    const cost = await runs.employerCostReport(biz.id, MORDAD);
    expect(cost.allocation).toHaveLength(2);
  });

  it("keeps an approved run and its payslips immutable, in the service and in the database", async () => {
    const run = await approvedRun();
    await expect(runs.calculateEngineRun({ ...actor(), runId: run.id })).rejects.toThrow("run_immutable");
    await expect(runs.updateEngineRunInputs({ ...actor(), runId: run.id, inputs: {} })).rejects.toThrow("run_immutable");
    await expect(runs.cancelEngineRun({ ...actor(), runId: run.id })).rejects.toThrow("run_immutable");
    const plain = new Client({ connectionString: urlFor(databaseName) });
    await plain.connect();
    try {
      await expect(plain.query(`UPDATE payroll_payslips SET net_pay = 1 WHERE run_id = $1`, [run.id])).rejects.toThrow(/immutable/);
      await expect(plain.query(`UPDATE payroll_engine_runs SET totals = '{}' WHERE id = $1`, [run.id])).rejects.toThrow(/immutable/);
      await expect(plain.query(`UPDATE payroll_engine_runs SET status = 'draft' WHERE id = $1`, [run.id])).rejects.toThrow(/transition/);
      await expect(plain.query(`DELETE FROM payroll_payslips WHERE run_id = $1`, [run.id])).rejects.toThrow(/cannot be deleted/);
      await expect(plain.query(`UPDATE payroll_rule_sets SET title = 'x' WHERE business_id = $1`, [biz.id])).rejects.toThrow(/append-only/);
    } finally {
      await plain.end();
    }
  });

  it("preserves the rule version a run used after a new version is entered", async () => {
    const run = await approvedRun();
    await setup.createRuleSet({ ...actor(), title: "نسخه جدید", effectiveFrom: "2025-03-21", rules: { employeeInsurancePercent: 9 } });
    const again = await runs.getEngineRun(biz.id, run.id);
    expect(again?.ruleSetVersion).toBe(1);
    const slips = await runs.listPayslips(biz.id, run.id);
    expect(slips.find((s) => s.userId === staff.a)!.employeeInsurance).toBe("10500000");
  });

  it("corrects a month with a supplemental run computed on the cumulative month", async () => {
    const run = await approvedRun();
    await runs.postEngineRun({ ...actor(), runId: run.id });
    await expect(runs.createEngineRun({ ...actor(), periodKey: MORDAD })).rejects.toThrow("period_already_has_run");
    const supp = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, runType: "supplemental", inputs: { [staff.a]: { items: [{ code: "BONUS", amount: "100000000" }] } } });
    expect(supp.sequence).toBe(2);
    await runs.calculateEngineRun({ ...actor(), runId: supp.id });
    const [slip] = await runs.listPayslips(biz.id, supp.id);
    // Month taxable = 150M − 10.5M + 100M = 239.5M → 10M + 7.9M = 17.9M; first run withheld 3.95M.
    expect(slip.incomeTax).toBe((17_900_000 - 3_950_000).toString());
    expect(slip.employeeInsurance).toBe("0"); // BONUS is not insurable
    await runs.reviewEngineRun({ ...actor(), runId: supp.id });
    await runs.approveEngineRun({ ...actor(), runId: supp.id });
    await runs.postEngineRun({ ...actor(), runId: supp.id });
    expect(await balance("2470")).toBe(17_900_000n);
    expect((await runs.payrollLiabilityReconciliation(biz.id)).reconciled).toBe(true);
  });

  it("is idempotent on create and never books a month that the #835 journal-level payroll holds", async () => {
    const a = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, idempotencyKey: "engine-key-1" });
    const b = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, idempotencyKey: "engine-key-1" });
    expect(b.id).toBe(a.id);
    expect(b.idempotentReplay).toBe(true);

    await db.query(`UPDATE users SET monthly_wage = 10000000 WHERE id = $1`, [staff.a]);
    await expect(legacy.accruePayroll({ businessId: biz.id, createdBy: owner.id, periodKey: MORDAD })).rejects.toThrow("period_held_by_engine");
    const journal = await legacy.accruePayroll({ businessId: biz.id, createdBy: owner.id, periodKey: SHAHRIVAR });
    expect(journal.id).toBeTruthy();
    await expect(runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR })).rejects.toThrow("period_held_by_journal_payroll");
  });

  it("recovers an advance once, across the engine and the #835 path", async () => {
    await advances.recordAdvance({ businessId: biz.id, userId: staff.a, amount: "5000000", method: "cash", createdBy: owner.id, advanceDate: "2025-07-25" });
    const run = await approvedRun();
    const slip = (await runs.listPayslips(biz.id, run.id)).find((s) => s.userId === staff.a)!;
    expect(slip.deductions.find((d) => d.code === "ADVANCE")?.amount).toBe("5000000");
    const owed = await advances.outstandingAdvances((t, p) => db.query(t, p as never) as never, biz.id);
    expect(owed.get(staff.a) ?? 0n).toBe(0n);
  });

  it("refuses to post into a locked fiscal period", async () => {
    const run = await approvedRun();
    await fiscal.createFiscalYear(biz.id, 1404);
    const [year] = await fiscal.listFiscalYears(biz.id);
    const mordad = (await fiscal.listPeriods(biz.id, year.id)).find((p) => p.label === MORDAD || p.startsOn === "2025-07-23")!;
    await fiscal.setPeriodStatus(biz.id, mordad.id, "soft_closed", owner.id);
    await fiscal.setPeriodStatus(biz.id, mordad.id, "locked", owner.id);
    await expect(runs.postEngineRun({ ...actor(), runId: run.id })).rejects.toThrow();
    expect((await runs.getEngineRun(biz.id, run.id))?.status).toBe("approved");
  });

  it("audits profile and component changes", async () => {
    await setup.saveProfile({ ...actor(), userId: staff.a, body: { baseSalary: "160000000" } });
    const changes = await setup.listProfileChanges(biz.id, staff.a);
    expect(changes.length).toBe(2);
    const comp = (await setup.listComponents(biz.id)).find((c) => c.code === "CHILD")!;
    await setup.saveComponent({ ...actor(), id: comp.id, body: { insurable: true } });
    expect((await setup.listComponentChanges(biz.id, comp.id)).length).toBe(1);
    await expect(setup.saveComponent({ ...actor(), id: (await setup.listComponents(biz.id)).find((c) => c.code === "TAX")!.id, body: { isActive: false } })).rejects.toThrow("system_component_locked");
  });
});
