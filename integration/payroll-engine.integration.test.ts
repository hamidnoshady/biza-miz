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
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let appRole: string;
let appPassword: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let setup: typeof import("../src/lib/payroll-engine-setup");
let runs: typeof import("../src/lib/payroll-engine-runs");
let legacy: typeof import("../src/lib/payroll-service");
let advances: typeof import("../src/lib/payroll-advances-service");
let fiscal: typeof import("../src/lib/fiscal-periods-service");
let commission: typeof import("../src/lib/commission-service");

const biz = { id: "" };
const owner = { id: "" };
const staff = { a: "", b: "" };

/** A closed month: Mordad 1404 = 2025-07-23 … 2025-08-22. */
const MORDAD = "1404-05";
const SHAHRIVAR = "1404-06";

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
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
  appRole = `payroll_engine_rls_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  appPassword = randomUUID();
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: appRole, password: appPassword, quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  setup = await import("../src/lib/payroll-engine-setup");
  runs = await import("../src/lib/payroll-engine-runs");
  legacy = await import("../src/lib/payroll-service");
  advances = await import("../src/lib/payroll-advances-service");
  fiscal = await import("../src/lib/fiscal-periods-service");
  commission = await import("../src/lib/commission-service");
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
    if (appRole) await dropAppRole(maintenance, appRole);
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
  await setup.saveProfile({
    businessId: biz.id,
    actorId: owner.id,
    userId: staff.a,
    body: {
      baseSalary: "150000000",
      payrollCode: "P-1",
      insuranceProfile: { insured: false },
      taxProfile: { exempt: true },
      paymentDestination: { method: "cash" },
      costAllocation: [{ percent: 60, label: "شعبه ۱" }, { percent: 40, label: "شعبه ۲" }],
    },
  });
  await setup.saveProfile({
    businessId: biz.id,
    actorId: owner.id,
    userId: staff.b,
    body: {
      baseSalary: 90_000_000,
      insuranceProfile: { insured: false },
      taxProfile: { exempt: true },
      paymentDestination: { method: "cash" },
    },
  });
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

/** Wait for Postgres itself to report a blocked advisory lock matching blockerPid. */
async function waitForAdvisoryWait(blockerPid: number): Promise<number> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await db.query<{ pid: number }>(
      `SELECT blocked.pid
         FROM pg_locks blocked
         JOIN pg_stat_activity waiter ON waiter.pid = blocked.pid
         JOIN pg_locks held ON held.locktype = 'advisory' AND held.granted
                           AND held.classid = blocked.classid AND held.objid = blocked.objid
                           AND held.objsubid = blocked.objsubid AND held.pid = $1
        WHERE blocked.locktype = 'advisory' AND NOT blocked.granted
          AND waiter.wait_event_type = 'Lock' AND waiter.wait_event = 'advisory'
          AND waiter.query LIKE '%pg_advisory_xact_lock%'
        LIMIT 1`,
      [blockerPid],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("payroll mutation never waited on the held business advisory lock");
}

describe("payroll engine — workflow", () => {
  it("calculates, approves, posts, pays and closes a month with exact figures", async () => {
    await setup.saveProfile({
      ...actor(),
      userId: staff.a,
      body: {
        insuranceProfile: { insured: true, insuranceNumber: "12345678901" },
        taxProfile: { exempt: false, nationalId: "0084575980" },
      },
    });
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

  it("pays from the selected canonical leaf account on the selected date and rejects foreign or clearing accounts", async () => {
    const bankRoot = (await db.query<{ id: string }>("SELECT id FROM accounts WHERE business_id = $1 AND code = '1110'", [biz.id])).rows[0].id;
    const selected = (await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, parent_id, code, name, type) VALUES ($1, $2, '11101', 'Operating bank', 'asset') RETURNING id`,
      [biz.id, bankRoot],
    )).rows[0].id;
    const clearing = (await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1120', 'Card clearing', 'asset') RETURNING id`,
      [biz.id],
    )).rows[0].id;
    const foreignBusiness = await otherBusiness();
    const foreignAccount = (await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'Foreign bank', 'asset') RETURNING id`,
      [foreignBusiness],
    )).rows[0].id;

    const run = await approvedRun();
    await runs.postEngineRun({ ...actor(), runId: run.id });
    await expect(runs.payEngineRun({ ...actor(), runId: run.id, paymentAccountId: foreignAccount, paidDate: "2025-08-25" })).rejects.toThrow("invalid_payment_account");
    await expect(runs.payEngineRun({ ...actor(), runId: run.id, paymentAccountId: clearing, paidDate: "2025-08-25" })).rejects.toThrow("invalid_payment_account");

    const paid = await runs.payEngineRun({ ...actor(), runId: run.id, method: "cash", paymentAccountId: selected, paidDate: "2025-08-25" });
    expect(paid.status).toBe("paid");
    expect(paid.paidDate).toBe("2025-08-25");
    expect(paid.paymentEntryId).toBeTruthy();
    const entry = await db.query<{ entry_date: string }>("SELECT entry_date::text AS entry_date FROM journal_entries WHERE id = $1", [paid.paymentEntryId]);
    expect(entry.rows[0].entry_date).toBe("2025-08-25");
    const lines = await db.query<{ account_id: string; credit: string }>(
      "SELECT account_id, credit::text AS credit FROM journal_lines WHERE entry_id = $1",
      [paid.paymentEntryId],
    );
    const payout = lines.rows.find((line) => line.account_id === selected);
    expect(payout?.credit).toBe(run.totals?.netPay);
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
    await setup.saveProfile({ ...actor(), userId: staff.a, body: { insuranceProfile: { insured: true, insuranceNumber: "12345678901" } } });
    const run = await approvedRun();
    await setup.createRuleSet({ ...actor(), title: "نسخه جدید", effectiveFrom: "2025-03-21", rules: { employeeInsurancePercent: 9 } });
    const again = await runs.getEngineRun(biz.id, run.id);
    expect(again?.ruleSetVersion).toBe(1);
    const slips = await runs.listPayslips(biz.id, run.id);
    expect(slips.find((s) => s.userId === staff.a)!.employeeInsurance).toBe("10500000");
  });

  it("corrects a month with a supplemental run computed on the cumulative month", async () => {
    await setup.saveProfile({
      ...actor(),
      userId: staff.a,
      body: {
        insuranceProfile: { insured: true, insuranceNumber: "12345678901" },
        taxProfile: { exempt: false, nationalId: "0084575980" },
      },
    });
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

  it("merges one typed input without losing allowances, deductions, other employees or inactive inputs", async () => {
    const original = {
      [staff.a]: { overtimeHours: 2, unpaidLeaveDays: 1, items: [{ code: "BONUS", amount: "1000000" }, { code: "CHILD", amount: "250000" }] },
      [staff.b]: { overtimeHours: 3, unpaidLeaveDays: 0, items: [{ code: "MEAL", amount: "750000" }] },
    };
    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, inputs: original });
    await setup.saveProfile({ ...actor(), userId: staff.b, body: { isActive: false } });

    await runs.updateEngineRunInputs({ ...actor(), runId: run.id, inputMode: "merge", inputs: { [staff.a]: { overtimeHours: 4 } } });
    const merged = (await runs.getEngineRun(biz.id, run.id))!.inputs!;
    expect(merged[staff.a]).toEqual({ overtimeHours: 4, unpaidLeaveDays: 1, items: original[staff.a].items });
    expect(merged[staff.b]).toEqual(original[staff.b]);

    await runs.updateEngineRunInputs({ ...actor(), runId: run.id, inputMode: "merge", removeEmployeeIds: [staff.b] });
    const explicitlyRemoved = (await runs.getEngineRun(biz.id, run.id))!.inputs!;
    expect(explicitlyRemoved).toEqual({ [staff.a]: { overtimeHours: 4, unpaidLeaveDays: 1, items: original[staff.a].items } });
  });

  it("binds create retries to the immutable normalized request, not later draft edits", async () => {
    const request = {
      ...actor(),
      periodKey: "۱۴۰۴-۰۵",
      runType: "regular",
      accrualDate: "2025-08-20",
      includeCommission: true,
      inputs: { [staff.a]: { overtimeHours: 2, unpaidLeaveDays: 1, items: [{ code: "BONUS", amount: "1250000" }] } },
      note: "create identity",
      idempotencyKey: "engine-immutable-request-865-001",
    };
    const created = await runs.createEngineRun(request);
    await runs.updateEngineRunInputs({
      ...actor(),
      runId: created.id,
      inputMode: "merge",
      inputs: { [staff.a]: { overtimeHours: 4 } },
      includeCommission: false,
      note: "draft changed after create",
    });

    const replay = await runs.createEngineRun({ ...request, periodKey: MORDAD });
    expect(replay.id).toBe(created.id);
    expect(replay.idempotentReplay).toBe(true);
    const current = await runs.getEngineRun(biz.id, created.id);
    expect(current?.inputs?.[staff.a]).toEqual({ overtimeHours: 4, unpaidLeaveDays: 1, items: [{ code: "BONUS", amount: "1250000" }] });
    expect(current?.includeCommission).toBe(false);
    expect(current?.note).toBe("draft changed after create");

    const persisted = (await db.query<{ idempotency_payload: Record<string, unknown> }>("SELECT idempotency_payload FROM payroll_engine_runs WHERE id = $1", [created.id])).rows[0];
    expect(persisted.idempotency_payload).toMatchObject({
      version: 1,
      periodKey: MORDAD,
      runType: "regular",
      accrualDate: "2025-08-20",
      accrualDateMode: "explicit",
      includeCommission: true,
      inputs: request.inputs,
      note: "create identity",
    });

    await expect(runs.createEngineRun({ ...request, periodKey: MORDAD, accrualDate: "2025-08-21" })).rejects.toThrow("idempotency_key_conflict");
    await expect(runs.createEngineRun({ ...request, periodKey: MORDAD, includeCommission: false })).rejects.toThrow("idempotency_key_conflict");
    await expect(runs.createEngineRun({ ...request, periodKey: MORDAD, inputs: { [staff.a]: { overtimeHours: 3 } } })).rejects.toThrow("idempotency_key_conflict");
  });

  it("does not infer a pre-0218 idempotency request from mutable draft edits", async () => {
    const key = "legacy-idempotency-865";
    const row = (await db.query<{ id: string }>(
      `INSERT INTO payroll_engine_runs (business_id, period_key, run_type, sequence, accrual_date, idempotency_key, idempotency_payload)
       VALUES ($1, $2, 'regular', 1, '2025-08-22', $3, '{"legacy":true}'::jsonb) RETURNING id`,
      [biz.id, SHAHRIVAR, key],
    )).rows[0];
    await db.query(
      `UPDATE payroll_engine_runs SET inputs = $2::jsonb, include_commission = false, note = 'edited draft' WHERE id = $1`,
      [row.id, JSON.stringify({ [staff.a]: { overtimeHours: 4 } })],
    );
    await expect(runs.createEngineRun({
      ...actor(),
      periodKey: SHAHRIVAR,
      idempotencyKey: key,
      includeCommission: false,
      inputs: { [staff.a]: { overtimeHours: 4 } },
      note: "edited draft",
    })).rejects.toThrow("idempotency_key_conflict");
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

  it("edits the canonical personnel code as text, preserves omission and clears an explicit null", async () => {
    const code = "۰۰۷";
    const saved = await setup.saveProfile({ ...actor(), userId: staff.a, body: { employeeCode: code } });
    expect(saved.employeeCode).toBe(code);
    expect((await db.query<{ employee_code: string }>("SELECT employee_code FROM employees WHERE id = $1 AND business_id = $2", [staff.a, biz.id])).rows[0].employee_code).toBe(code);

    const preserved = await setup.saveProfile({ ...actor(), userId: staff.a, body: { employmentType: "part_time" } });
    expect(preserved.employeeCode).toBe(code);
    const cleared = await setup.saveProfile({ ...actor(), userId: staff.a, body: { employeeCode: null } });
    expect(cleared.employeeCode).toBeNull();
    expect((await db.query<{ employee_code: string | null }>("SELECT employee_code FROM employees WHERE id = $1 AND business_id = $2", [staff.a, biz.id])).rows[0].employee_code).toBeNull();
    expect(await setup.listProfileChanges(biz.id, staff.a)).toHaveLength(4);
  });

  it("clears a hire date inherited from the canonical team identity when explicitly requested", async () => {
    await db.query("INSERT INTO employees (id, business_id, hired_at) VALUES ($1, $2, '2025-01-02')", [staff.a, biz.id]);
    expect((await setup.getProfile(biz.id, staff.a))?.hireDate).toBe("2025-01-02");
    const profile = await setup.saveProfile({ ...actor(), userId: staff.a, body: { hireDate: null } });
    expect(profile.hireDate).toBeNull();
    expect((await db.query<{ hired_at: string | null }>("SELECT hired_at::text FROM employees WHERE id = $1 AND business_id = $2", [staff.a, biz.id])).rows[0].hired_at).toBeNull();
  });

  it("validates required insurance, tax and bank fields against the canonical in-tenant chart", async () => {
    const { rows: localBank } = await db.query<{ id: string }>("SELECT id FROM accounts WHERE business_id = $1 AND code = '1110'", [biz.id]);
    const other = await otherBusiness();
    const { rows: foreignBank } = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'Foreign bank', 'asset') RETURNING id",
      [other],
    );
    const valid = await setup.saveProfile({
      ...actor(),
      userId: staff.a,
      body: {
        employmentType: "part_time",
        insuranceProfile: { insured: true, insuranceNumber: "12345678901" },
        taxProfile: { exempt: false, nationalId: "0084575980" },
        paymentDestination: { method: "bank", paymentAccountId: localBank[0].id, iban: "IR830540102380270014203457", cardNumber: "6037701689095385" },
      },
    });
    expect(valid.employmentType).toBe("part_time");
    expect(valid.insuranceProfile).toMatchObject({ insured: true, insuranceNumber: "12345678901" });
    expect(valid.taxProfile).toMatchObject({ exempt: false, nationalId: "0084575980" });
    expect(valid.paymentDestination).toMatchObject({ method: "bank", paymentAccountId: localBank[0].id, iban: "IR830540102380270014203457" });

    await expect(setup.saveProfile({
      ...actor(),
      userId: staff.a,
      body: { paymentDestination: { method: "bank", paymentAccountId: foreignBank[0].id, iban: "IR830540102380270014203457" } },
    })).rejects.toThrow("invalid_payment_account");
    const audit = JSON.stringify(await setup.listProfileChanges(biz.id, staff.a));
    for (const secret of ["12345678901", "0084575980", "IR830540102380270014203457", "6037701689095385"]) {
      expect(audit).not.toContain(secret);
    }
  });

  it("creates, edits and audits custom components while locking statutory behavior", async () => {
    const component = await setup.saveComponent({
      ...actor(),
      body: { code: "MEAL", name: "Meal allowance", kind: "earning", taxable: true, insurable: false, debitAccountCode: "5200", creditAccountCode: "2300", effectiveFrom: "2025-01-01", effectiveTo: null, isActive: true },
    });
    expect(component).toMatchObject({ code: "MEAL", kind: "earning", taxable: true, insurable: false, effectiveFrom: "2025-01-01", isActive: true });
    const edited = await setup.saveComponent({
      ...actor(),
      id: component.id,
      body: { name: "Meal deduction", kind: "deduction", taxable: false, insurable: false, debitAccountCode: "2490", creditAccountCode: "2300", effectiveFrom: "2025-01-01", effectiveTo: null, isActive: true },
    });
    expect(edited).toMatchObject({ name: "Meal deduction", kind: "deduction", taxable: false, debitAccountCode: "2490" });
    expect(await setup.listComponentChanges(biz.id, component.id)).toHaveLength(2);

    const base = (await setup.listComponents(biz.id)).find((entry) => entry.systemKey === "base_wage")!;
    expect((await setup.saveComponent({ ...actor(), id: base.id, body: { code: "BASE_WAGE" } })).systemKey).toBe("base_wage");
    await expect(setup.saveComponent({ ...actor(), id: base.id, body: { taxable: false } })).rejects.toThrow("system_component_locked");
    await expect(setup.saveComponent({
      ...actor(),
      body: { code: "EMPLOYER", name: "Employer", kind: "employer_contribution", debitAccountCode: "5220", creditAccountCode: "2460" },
    })).rejects.toThrow("system_component_locked");
  });

  it("retains recurring-item history after end and makes an identical end idempotent", async () => {
    const component = (await setup.listComponents(biz.id)).find((entry) => entry.code === "HOUSING")!;
    const item = await setup.addItem({ ...actor(), body: { userId: staff.a, componentId: component.id, amount: "750000", effectiveFrom: "2025-07-23", note: "housing" } });
    expect(await setup.listItemChanges(biz.id, item.id)).toHaveLength(1);
    const ended = await setup.endItem({ ...actor(), itemId: item.id, effectiveTo: "2025-08-10" });
    expect(ended).toMatchObject({ id: item.id, effectiveTo: "2025-08-10" });
    expect(await setup.listItemChanges(biz.id, item.id)).toHaveLength(2);
    await setup.endItem({ ...actor(), itemId: item.id, effectiveTo: "2025-08-10" });
    expect(await setup.listItemChanges(biz.id, item.id)).toHaveLength(2);
    await expect(setup.addItem({ ...actor(), body: { userId: staff.a, componentId: component.id, amount: "100", effectiveFrom: "2025-01-01", effectiveTo: "2000-01-01" } })).rejects.toThrow("invalid_effective_date");
  });

  it("reserves commission once for an engine run and releases it on cancellation", async () => {
    const branch = await location(biz.id, "Counter");
    await commission.upsertCommissionRule(biz.id, { employeeId: staff.a, kind: "percent", basis: "net", value: 10 });
    const client = await dbLib.getPool().connect();
    let accrualId = "";
    try {
      await client.query("BEGIN");
      const result = await commission.accrueCommissionForLine(client, {
        businessId: biz.id,
        locationId: branch,
        employeeId: staff.a,
        sourceType: "order_item",
        sourceId: randomUUID(),
        line: { net: 50_000_000, cost: 0, itemId: randomUUID() },
      });
      expect(result.amount).toBe(5_000_000);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const [commissionRow] = (await db.query<{ id: string }>("SELECT id FROM commission_accruals WHERE business_id = $1 AND employee_id = $2", [biz.id, staff.a])).rows;
    accrualId = commissionRow.id;
    const today = (await db.query<{ today: string }>("SELECT CURRENT_DATE::text AS today")).rows[0].today;

    const first = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, accrualDate: today, includeCommission: true });
    await runs.calculateEngineRun({ ...actor(), runId: first.id });
    expect((await runs.getEngineRun(biz.id, first.id))?.totals?.commission).toBe("5000000");
    expect((await runs.listPayslips(biz.id, first.id)).find((slip) => slip.userId === staff.a)?.earnings.find((line) => line.code === "COMMISSION")?.amount).toBe("5000000");
    expect((await db.query<{ id: string | null }>("SELECT payroll_engine_run_id AS id FROM commission_accruals WHERE id = $1", [accrualId])).rows[0].id).toBe(first.id);

    const competing = await runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR, accrualDate: today, includeCommission: true });
    await runs.calculateEngineRun({ ...actor(), runId: competing.id });
    expect((await runs.getEngineRun(biz.id, competing.id))?.totals?.commission).toBe("0");

    await runs.cancelEngineRun({ ...actor(), runId: first.id });
    expect((await db.query<{ id: string | null }>("SELECT payroll_engine_run_id AS id FROM commission_accruals WHERE id = $1", [accrualId])).rows[0].id).toBeNull();
    const retry = await runs.createEngineRun({ ...actor(), periodKey: "1404-07", accrualDate: today, includeCommission: true });
    await runs.calculateEngineRun({ ...actor(), runId: retry.id });
    expect((await runs.getEngineRun(biz.id, retry.id))?.totals?.commission).toBe("5000000");
  });
});

// ---------------------------------------------------------------------------
// #865 completion: partial months, signed corrections, dimensioned posting,
// strict filters, tenant-safe allocation, database identity, concurrency and a
// snapshot-consistent reconciliation.
// ---------------------------------------------------------------------------

async function location(businessId: string, name = "شعبه"): Promise<string> {
  return (await db.query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id`, [businessId, name])).rows[0].id;
}

async function project(businessId: string, name = "پروژه"): Promise<string> {
  return (await db.query<{ id: string }>(`INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, $2, 'test') RETURNING id`, [businessId, name])).rows[0].id;
}

async function otherBusiness(): Promise<string> {
  return (await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id", [`oth-${randomUUID().slice(0, 8)}`])).rows[0].id;
}

async function advance(runId: string, ...steps: Array<"review" | "approve" | "post">) {
  for (const step of steps) {
    if (step === "review") await runs.reviewEngineRun({ ...actor(), runId });
    if (step === "approve") await runs.approveEngineRun({ ...actor(), runId });
    if (step === "post") await runs.postEngineRun({ ...actor(), runId });
  }
}

describe("payroll engine — partial months", () => {
  it("prorates base pay over the days employed and a recurring item over its own window", async () => {
    // Mordad 1404 = 2025-07-23 … 2025-08-22 (31 days); hired 2025-08-02 → 21 days of a 30-day basis.
    await setup.saveProfile({ ...actor(), userId: staff.b, body: { hireDate: "2025-08-02" } });
    const housing = (await setup.listComponents(biz.id)).find((c) => c.code === "HOUSING")!;
    // Item from 2025-08-13 → 10 days of the month.
    await setup.addItem({ ...actor(), body: { userId: staff.b, componentId: housing.id, amount: "9000000", effectiveFrom: "2025-08-13" } });
    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD });
    await runs.calculateEngineRun({ ...actor(), runId: run.id });
    const sara = (await runs.listPayslips(biz.id, run.id)).find((s) => s.userId === staff.b)!;
    expect(sara.workedDays).toBe(21);
    expect(sara.baseSalary).toBe("90000000");
    expect(sara.earnings.find((e) => e.code === "BASE")!.amount).toBe("63000000");
    expect(sara.earnings.find((e) => e.code === "HOUSING")!.amount).toBe("3000000");
    expect(sara.netPay).toBe("66000000");
    // A full-month employee is paid in full whatever the month's calendar length.
    const ali = (await runs.listPayslips(biz.id, run.id)).find((s) => s.userId === staff.a)!;
    expect(ali.workedDays).toBe(30);
    expect(ali.earnings.find((e) => e.code === "BASE")!.amount).toBe("150000000");
  });

  it("stops at the termination date", async () => {
    await setup.saveProfile({ ...actor(), userId: staff.b, body: { terminationDate: "2025-07-27" } });
    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD });
    await runs.calculateEngineRun({ ...actor(), runId: run.id });
    const sara = (await runs.listPayslips(biz.id, run.id)).find((s) => s.userId === staff.b)!;
    expect(sara.workedDays).toBe(5);
    expect(sara.netPay).toBe("15000000");
  });
});

describe("payroll engine — signed corrections", () => {
  it("reverses overtime with a supplemental run, carries the debt on 1260 and recovers it next month", async () => {
    // Sara: uninsured and tax-exempt, so the figures are exactly base and overtime.
    const regular = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, inputs: { [staff.b]: { overtimeHours: 10 } } });
    await runs.calculateEngineRun({ ...actor(), runId: regular.id });
    await advance(regular.id, "review", "approve", "post");
    const paidOt = BigInt((await runs.listPayslips(biz.id, regular.id)).find((s) => s.userId === staff.b)!.earnings.find((e) => e.code === "OVERTIME")!.amount);
    // 90M / 192h × 1.4 × 10h = 6,562,500
    expect(paidOt).toBe(6_562_500n);

    await expect(
      runs.createEngineRun({ ...actor(), periodKey: MORDAD, runType: "supplemental", inputs: { [staff.b]: { overtimeHours: -11 } } }).then((r) =>
        runs.calculateEngineRun({ ...actor(), runId: r.id }),
      ),
    ).rejects.toThrow("invalid_overtime_hours");
    const pending = (await runs.listEngineRuns(biz.id)).find((r) => r.runType === "supplemental" && r.status === "draft")!;
    await runs.cancelEngineRun({ ...actor(), runId: pending.id });

    const supp = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, runType: "supplemental", inputs: { [staff.b]: { overtimeHours: -10 } } });
    await runs.calculateEngineRun({ ...actor(), runId: supp.id });
    const [fix] = await runs.listPayslips(biz.id, supp.id);
    expect(fix.overtimeHours).toBe(-10);
    expect(fix.earnings.find((e) => e.code === "OVERTIME")!.amount).toBe((-paidOt).toString());
    expect(fix.netPay).toBe("0");
    expect(fix.employeeDebt).toBe(paidOt.toString());
    await advance(supp.id, "review", "approve", "post");
    expect(-(await balance("1260"))).toBe(paidOt);
    expect((await runs.payrollLiabilityReconciliation(biz.id)).reconciled).toBe(true);

    // The debt is owed through payroll — the one ledger of what a member owes.
    const owed = await advances.outstandingAdvances((t, p) => db.query(t, p as never) as never, biz.id);
    expect(owed.get(staff.b)).toBe(paidOt);

    const next = await runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR });
    await runs.calculateEngineRun({ ...actor(), runId: next.id });
    const sara = (await runs.listPayslips(biz.id, next.id)).find((s) => s.userId === staff.b)!;
    expect(sara.deductions.find((d) => d.code === "ADVANCE")!.amount).toBe(paidOt.toString());
    await advance(next.id, "review", "approve", "post");
    expect(await balance("1260")).toBe(0n);
    expect((await advances.outstandingAdvances((t, p) => db.query(t, p as never) as never, biz.id)).get(staff.b) ?? 0n).toBe(0n);
    expect((await runs.payrollLiabilityReconciliation(biz.id)).reconciled).toBe(true);
  });

  it("gives back unpaid leave deducted in error", async () => {
    const regular = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, inputs: { [staff.b]: { unpaidLeaveDays: 2 } } });
    await runs.calculateEngineRun({ ...actor(), runId: regular.id });
    await advance(regular.id, "review", "approve", "post");
    const supp = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, runType: "supplemental", inputs: { [staff.b]: { unpaidLeaveDays: -2 } } });
    await runs.calculateEngineRun({ ...actor(), runId: supp.id });
    const [fix] = await runs.listPayslips(biz.id, supp.id);
    expect(fix.netPay).toBe("6000000"); // 90M / 30 × 2
    expect(fix.employeeDebt).toBe("0");
  });
});

describe("payroll engine — dimensioned posting", () => {
  it("posts one balanced entry per branch × project bucket, summing exactly to the run", async () => {
    const branch = await location(biz.id, "شعبه مرکزی");
    const proj = await project(biz.id, "پروژه الف");
    await setup.saveProfile({
      ...actor(),
      userId: staff.a,
      body: { costAllocation: [{ percent: 33.33, locationId: branch }, { percent: 66.67, locationId: branch, projectId: proj }] },
    });
    const run = await approvedRun();
    const posted = await runs.postEngineRun({ ...actor(), runId: run.id });
    // Ali's two buckets + Sara's undimensioned one.
    expect(posted.accrualEntryIds).toHaveLength(3);
    const { rows } = await db.query<{ id: string; location_id: string | null; project_id: string | null; posting_kind: string; dr: string; cr: string; expense: string }>(
      `SELECT je.id, je.location_id, je.project_id, je.posting_kind, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr,
              COALESCE(sum(jl.debit - jl.credit) FILTER (WHERE a.code = '5200'), 0)::text AS expense
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id JOIN accounts a ON a.id = jl.account_id
        WHERE je.business_id = $1 AND je.source_type = 'payroll_engine_accrual' AND je.source_id = $2
        GROUP BY je.id ORDER BY je.posting_kind`,
      [biz.id, run.id],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.dr).toBe(r.cr);
    expect(rows.map((r) => r.posting_kind)).toEqual([`alloc:-:-`, `alloc:${branch}:-`, `alloc:${branch}:${proj}`].sort());
    const byKind = Object.fromEntries(rows.map((r) => [r.posting_kind, r]));
    expect(byKind[`alloc:${branch}:${proj}`].project_id).toBe(proj);
    expect(byKind[`alloc:${branch}:-`].location_id).toBe(branch);
    expect(byKind["alloc:-:-"].location_id).toBeNull();
    // 150M × 33.33% = 49,995,000; the rest exactly to the other share; Sara 90M undimensioned.
    expect(byKind[`alloc:${branch}:-`].expense).toBe("49995000");
    expect(byKind[`alloc:${branch}:${proj}`].expense).toBe("100005000");
    expect(byKind["alloc:-:-"].expense).toBe("90000000");
    expect((await runs.payrollLiabilityReconciliation(biz.id)).reconciled).toBe(true);
    // The ledger's unique posting key refuses a second post of any bucket.
    const plain = new Client({ connectionString: urlFor(databaseName) });
    await plain.connect();
    try {
      await plain.query("SELECT set_config('app.rls_bypass', 'on', false)");
      await expect(
        plain.query(
          `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, source_id, posting_kind) VALUES ($1, '2025-08-22', 'x', 'payroll_engine_accrual', $2, 'alloc:-:-')`,
          [biz.id, run.id],
        ),
      ).rejects.toThrow(/uq_journal_business_source_posting|duplicate/);
    } finally {
      await plain.end();
    }
  });

  it("refuses a branch or project of another business, or one that is closed or archived", async () => {
    const other = await otherBusiness();
    const foreignBranch = await location(other);
    const foreignProject = await project(other);
    const save = (costAllocation: unknown) => setup.saveProfile({ ...actor(), userId: staff.a, body: { costAllocation } });
    await expect(save([{ percent: 100, locationId: foreignBranch }])).rejects.toThrow("invalid_cost_allocation");
    await expect(save([{ percent: 100, projectId: foreignProject }])).rejects.toThrow("invalid_cost_allocation");
    const closed = await location(biz.id);
    await db.query(`UPDATE locations SET is_active = false WHERE id = $1`, [closed]);
    await expect(save([{ percent: 100, locationId: closed }])).rejects.toThrow("invalid_cost_allocation");

    // Valid when saved, archived before the run: the calculation refuses rather than post to it.
    const proj = await project(biz.id);
    await save([{ percent: 100, projectId: proj }]);
    await db.query(`UPDATE ai_projects SET archived_at = now() WHERE id = $1`, [proj]);
    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD });
    await expect(runs.calculateEngineRun({ ...actor(), runId: run.id })).rejects.toMatchObject({
      message: "invalid_cost_allocation",
      details: { userId: staff.a, projectId: proj },
    });
  });
});

describe("payroll engine — strict report filters", () => {
  it("refuses malformed run ids, periods and years instead of widening the report", async () => {
    await approvedRun();
    await expect(runs.payrollRegister(biz.id, { runId: "not-a-uuid" })).rejects.toThrow("invalid_run_id");
    await expect(runs.payrollRegister(biz.id, { runId: randomUUID(), periodKey: "1404-13" })).rejects.toThrow("invalid_period");
    await expect(runs.payrollRegister(biz.id, { periodKey: "garbage" })).rejects.toThrow("invalid_period");
    await expect(runs.payrollRegister(biz.id, {})).rejects.toThrow("invalid_period");
    expect((await runs.payrollRegister(biz.id, { runId: randomUUID() })).payslips).toHaveLength(0);
    await expect(runs.employeePayrollCard(biz.id, staff.a, " 1404")).rejects.toThrow("invalid_period");
    await expect(runs.employeePayrollCard(biz.id, "x", "1404")).rejects.toThrow("invalid_user_id");
    expect((await runs.employeePayrollCard(biz.id, staff.a, "1404")).payslips).toHaveLength(1);
    const comparison = await runs.periodComparison(biz.id, MORDAD, SHAHRIVAR);
    expect(comparison.a?.periodKey).toBe(MORDAD);
    expect(comparison.b).toBeNull();
    expect(comparison.difference.gross).toBe((-BigInt(comparison.a?.gross ?? "0")).toString());
    await expect(runs.periodComparison(biz.id, MORDAD, "1404-6x")).rejects.toThrow("invalid_period");

    const foreignBusiness = await otherBusiness();
    const foreignUser = (await db.query<{ id: string }>(
      "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Foreign', 'x') RETURNING id",
      [foreignBusiness],
    )).rows[0].id;
    await expect(runs.employeePayrollCard(biz.id, foreignUser, "1404")).rejects.toThrow("staff_not_found");
    await expect(runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR, inputs: { [foreignUser]: { overtimeHours: 1 } } })).rejects.toThrow("employee_not_in_payroll");
    const patchable = await runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR });
    await expect(runs.updateEngineRunInputs({
      ...actor(),
      runId: patchable.id,
      inputMode: "merge",
      inputs: { [foreignUser]: { overtimeHours: 0 } },
    })).rejects.toThrow("employee_not_in_payroll");
    expect((await runs.getEngineRun(biz.id, patchable.id))?.inputs).toEqual({});
    const component = (await setup.listComponents(biz.id)).find((entry) => entry.code === "HOUSING")!;
    await expect(setup.addItem({ ...actor(), body: { userId: foreignUser, componentId: component.id, amount: "100", effectiveFrom: "2025-07-23" } })).rejects.toThrow("staff_not_found");
  });
});

describe("payroll engine — recurring-item tenant isolation", () => {
  it("forces RLS on every payroll tenant table and isolates item-audit reads and writes for a non-bypass role", async () => {
    const localComponent = (await setup.listComponents(biz.id)).find((entry) => entry.code === "HOUSING")!;
    const localItem = await setup.addItem({ ...actor(), body: { userId: staff.a, componentId: localComponent.id, amount: "100", effectiveFrom: "2025-07-23" } });

    const other = await otherBusiness();
    const { rows: foreignUser } = await db.query<{ id: string }>(
      "INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Foreign owner', 'x') RETURNING id",
      [other],
    );
    const foreignComponent = (await setup.listComponents(other)).find((entry) => entry.code === "HOUSING")!;
    const foreignItem = await setup.addItem({
      businessId: other,
      actorId: foreignUser[0].id,
      body: { userId: foreignUser[0].id, componentId: foreignComponent.id, amount: "200", effectiveFrom: "2025-07-23" },
    });

    const app = new Client({ connectionString: urlFor(databaseName, { name: appRole, password: appPassword }) });
    await app.connect();
    try {
      const role = (await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      )).rows[0];
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const tenantTables = [
        "payroll_rule_sets",
        "payroll_components",
        "payroll_component_changes",
        "payroll_employee_profiles",
        "payroll_profile_changes",
        "payroll_employee_items",
        "payroll_engine_runs",
        "payroll_payslips",
        "payroll_employee_item_changes",
      ];
      const rls = await app.query<{ table_name: string; row_security: boolean; force_row_security: boolean; tenant_policy: boolean }>(
        `SELECT c.relname AS table_name, c.relrowsecurity AS row_security,
                c.relforcerowsecurity AS force_row_security,
                EXISTS (
                  SELECT 1 FROM pg_policies p
                   WHERE p.schemaname = n.nspname AND p.tablename = c.relname
                     AND p.policyname = 'tenant_isolation' AND p.cmd = 'ALL'
                ) AS tenant_policy
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])
          ORDER BY c.relname`,
        [tenantTables],
      );
      expect(rls.rows.map((row) => row.table_name)).toEqual([...tenantTables].sort());
      expect(rls.rows.every((row) => row.row_security && row.force_row_security && row.tenant_policy)).toBe(true);
      await app.query("SELECT set_config('app.business_id', $1, false), set_config('app.rls_bypass', '', false)", [biz.id]);
      const visible = await app.query<{ item_id: string; business_id: string }>(
        "SELECT item_id, business_id FROM payroll_employee_item_changes ORDER BY item_id",
      );
      expect(visible.rows).toEqual([{ item_id: localItem.id, business_id: biz.id }]);
      expect((await app.query("SELECT id FROM payroll_employee_item_changes WHERE business_id = $1", [other])).rowCount).toBe(0);
      expect((await app.query("UPDATE payroll_employee_item_changes SET after = '{}'::jsonb WHERE business_id = $1", [other])).rowCount).toBe(0);
      await expect(app.query("UPDATE payroll_employee_item_changes SET after = '{}'::jsonb WHERE item_id = $1", [localItem.id])).rejects.toMatchObject({ code: "55000" });
      await expect(app.query(
        `INSERT INTO payroll_employee_item_changes (business_id, item_id, before, after, changed_by)
         VALUES ($1, $2, NULL, '{}'::jsonb, $3)`,
        [other, foreignItem.id, foreignUser[0].id],
      )).rejects.toMatchObject({ code: "42501" });
      await expect(app.query(
        `INSERT INTO payroll_employee_item_changes (business_id, item_id, before, after, changed_by)
         VALUES ($1, $2, NULL, '{}'::jsonb, $3)`,
        [biz.id, foreignItem.id, owner.id],
      )).rejects.toMatchObject({ code: "23503" });
    } finally {
      await app.end();
    }
  });
});

describe("payroll engine — database identity", () => {
  it("refuses moving a payslip between runs or businesses, in either direction", async () => {
    const approved = await approvedRun();
    const draft = await runs.createEngineRun({ ...actor(), periodKey: SHAHRIVAR });
    await runs.calculateEngineRun({ ...actor(), runId: draft.id });
    const plain = new Client({ connectionString: urlFor(databaseName) });
    await plain.connect();
    try {
      await plain.query("SELECT set_config('app.rls_bypass', 'on', false)");
      // Out of an approved run, net changed on the way — the original #6 hole.
      await expect(
        plain.query(`UPDATE payroll_payslips SET run_id = $2, net_pay = 1 WHERE run_id = $1`, [approved.id, draft.id]),
      ).rejects.toThrow(/immutable|cannot be moved/);
      // Into an approved run from a draft.
      await expect(plain.query(`UPDATE payroll_payslips SET run_id = $2 WHERE run_id = $1`, [draft.id, approved.id])).rejects.toThrow(
        /immutable|cannot be moved/,
      );
      const other = await otherBusiness();
      await expect(plain.query(`UPDATE payroll_payslips SET business_id = $2 WHERE run_id = $1`, [draft.id, other])).rejects.toThrow(
        /cannot be moved|foreign key/,
      );
      await expect(plain.query(`UPDATE payroll_engine_runs SET period_key = '1404-07' WHERE id = $1`, [draft.id])).rejects.toThrow(/identity|immutable/);
      // A payslip cannot point at another business's run, even on insert.
      await expect(
        plain.query(
          `INSERT INTO payroll_payslips (business_id, run_id, employee_name_snapshot, gross, net_pay, employer_cost, lines, cost_allocation)
           VALUES ($1, $2, 'x', 0, 0, 0, '[]', '[]')`,
          [other, draft.id],
        ),
      ).rejects.toThrow(/foreign key|violates/);
    } finally {
      await plain.end();
    }
  });
});

describe("payroll engine — concurrency", () => {
  it("waits for the shared per-business lock before writing, proven by Postgres lock state", async () => {
    const blocker = new Client({ connectionString: urlFor(databaseName) });
    await blocker.connect();
    let mutation: Promise<unknown> | null = null;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`payroll:${biz.id}`]);
      const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      mutation = setup.saveProfile({ ...actor(), userId: staff.a, body: { baseSalary: "155000000" } });

      const waiterPid = await waitForAdvisoryWait(blockerPid);
      expect(waiterPid).not.toBe(blockerPid);
      const beforeRelease = (await db.query<{ base_salary: string }>(
        "SELECT base_salary::text FROM payroll_employee_profiles WHERE business_id = $1 AND user_id = $2",
        [biz.id, staff.a],
      )).rows[0].base_salary;
      expect(beforeRelease).toBe("150000000");

      await blocker.query("COMMIT");
      await mutation;
      const afterRelease = (await db.query<{ base_salary: string }>(
        "SELECT base_salary::text FROM payroll_employee_profiles WHERE business_id = $1 AND user_id = $2",
        [biz.id, staff.a],
      )).rows[0].base_salary;
      expect(afterRelease).toBe("155000000");
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      if (mutation) await mutation.catch(() => undefined);
      await blocker.end();
    }
  });

  it("posts once under a racing double post", async () => {
    const run = await approvedRun();
    const results = await Promise.allSettled([runs.postEngineRun({ ...actor(), runId: run.id }), runs.postEngineRun({ ...actor(), runId: run.id })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.message).toBe("already_posted");
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM journal_entries WHERE source_type = 'payroll_engine_accrual' AND source_id = $1`, [run.id]);
    expect(rows[0].n).toBe(String((await runs.getEngineRun(biz.id, run.id))!.accrualEntryIds.length));
  });

  it("recovers an advance once when the engine and the #835 path claim it at the same time", async () => {
    await advances.recordAdvance({ businessId: biz.id, userId: staff.a, amount: "5000000", method: "cash", createdBy: owner.id, advanceDate: "2025-07-25" });
    await db.query(`UPDATE users SET monthly_wage = 10000000 WHERE id = $1`, [staff.a]);
    const run = await runs.createEngineRun({ ...actor(), periodKey: MORDAD });
    const settled = await Promise.allSettled([
      runs.calculateEngineRun({ ...actor(), runId: run.id }),
      legacy.accruePayroll({ businessId: biz.id, createdBy: owner.id, periodKey: SHAHRIVAR }),
    ]);
    // Both must really run — a claim that failed for another reason would make this pass vacuously.
    expect(settled.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))).toEqual(["ok", "ok"]);
    const { rows } = await db.query<{ total: string }>(
      `SELECT (COALESCE((SELECT sum(advance_recovery) FROM payroll_payslips WHERE run_id = $1 AND user_id = $2), 0)
             + COALESCE((SELECT sum(rl.advance_recovery) FROM payroll_run_lines rl JOIN payroll_runs r ON r.id = rl.run_id
                          WHERE r.business_id = $3 AND r.status <> 'voided' AND rl.user_id = $2), 0))::text AS total`,
      [run.id, staff.a, biz.id],
    );
    expect(rows[0].total).toBe("5000000");
  });
});

describe("payroll engine — reconciliation snapshot", () => {
  it("reads one snapshot, so a post committed mid-report does not unbalance it", async () => {
    const first = await approvedRun();
    await runs.postEngineRun({ ...actor(), runId: first.id });
    const supp = await runs.createEngineRun({ ...actor(), periodKey: MORDAD, runType: "supplemental", inputs: { [staff.a]: { items: [{ code: "BONUS", amount: "100000000" }] } } });
    await runs.calculateEngineRun({ ...actor(), runId: supp.id });
    await advance(supp.id, "review", "approve");
    const recon = await runs.payrollLiabilityReconciliation(biz.id, {
      onSnapshotTaken: async () => {
        await runs.postEngineRun({ ...actor(), runId: supp.id });
      },
    });
    // Every read saw the database before the post: one run, its two payslips, and a ledger that matches them.
    // Under READ COMMITTED the payslip read would already include the supplemental's payslip (3).
    expect(recon.runs).toBe(1);
    expect(recon.payslips).toBe(2);
    expect(recon.reconciled).toBe(true);
    const after = await runs.payrollLiabilityReconciliation(biz.id);
    expect(after.runs).toBe(2);
    expect(after.payslips).toBe(3);
    expect(after.reconciled).toBe(true);
  });
});
