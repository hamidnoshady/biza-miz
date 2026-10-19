/**
 * Ledger-section regressions, pinned.
 *
 * 1. **An archived account still reports its postings.** `setAccountActive`
 *    lets any non-well-known account be archived, postings and all — its own
 *    doc comment promises "a trial balance or statement still shows every
 *    posting an archived account ever received". The trial balance and the
 *    accounting dashboard both filtered on `is_active`, so archiving one side
 *    of a balanced entry dropped that side from the report: the totals stopped
 *    matching and both screens announced «دفتر نامتوازن است» about a book that
 *    was fine.
 *
 * 2. **The green "دفتر متوازن است" badge is not a zero-equals-zero shortcut.**
 *    An empty ledger has no document to audit yet, and two corrupt documents
 *    can cancel each other in the grand totals. The reports therefore expose
 *    entry-level health alongside debit/credit totals.
 *
 * 3. **Cash and bank means the 1100–1130 block, not four exact account codes.**
 *    A business can add its own bank/cash sub-account in that range and it must
 *    still appear in the Accounting dashboard's liquidity tile.
 *
 * 4. **An installment plan's «مانده» is the sum of its unpaid slices.** It used
 *    to be `principal - paidTotal`, which is a different number as soon as a
 *    plan has a down payment (the down payment is not a slice, so the balance
 *    never reached zero — «تسویه شده» sat next to a non-zero مانده) or interest
 *    (the schedule totals more than the principal, so the balance was
 *    understated).
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
let accountsService: typeof import("../src/lib/accounts-service");
let reports: typeof import("../src/lib/ledger-reports-service");
let installments: typeof import("../src/lib/installments-service");
let fiscalPeriods: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const acct = { cash: "", rent: "", receivable: "", revenue: "" };
const FULL_REPORT_SCOPE = { dateFrom: "0001-01-01", dateTo: "9999-12-31" } as const;
const user = { id: "" };
const party = { id: "" };

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
  databaseName = `pos_ledger_reports_${randomUUID().replaceAll("-", "")}`;

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
  accountsService = await import("../src/lib/accounts-service");
  reports = await import("../src/lib/ledger-reports-service");
  installments = await import("../src/lib/installments-service");
  fiscalPeriods = await import("../src/lib/fiscal-periods-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM payments");
  await db.query("DELETE FROM installment_items");
  await db.query("DELETE FROM installments");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Ledger Reports Co', $1) RETURNING id",
    [`lr-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'صندوق', 'asset'),
            ($1, '1200', 'حساب‌های دریافتنی', 'asset'),
            ($1, '4900', 'سایر درآمدها', 'revenue'),
            ($1, '5300', 'اجاره', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1200") acct.receivable = r.id;
    if (r.code === "4900") acct.revenue = r.id;
    if (r.code === "5300") acct.rent = r.id;
  }

  const partyRow = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'مشتری قسطی', 'customer') RETURNING id`,
    [biz.id],
  );
  party.id = partyRow.rows[0].id;
});

/** One balanced entry: 1,000,000 Rial of rent paid from the till. */
async function postRentEntry(): Promise<void> {
  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, CURRENT_DATE, 'اجاره', 'manual', $2) RETURNING id`,
    [biz.id, user.id],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, 1000000, 0), ($1, $3, 0, 1000000)`,
    [entry.rows[0].id, acct.rent, acct.cash],
  );
}

async function postManualLines(
  memo: string,
  lines: { accountId: string; debit: number | string; credit: number | string }[],
  entryDate?: string,
  sourceType = "manual",
): Promise<string> {
  const entry = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3, $4, $5) RETURNING id`,
    [biz.id, entryDate ?? null, memo, sourceType, user.id],
  );
  for (const line of lines) {
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)`,
      [entry.rows[0].id, line.accountId, line.debit, line.credit],
    );
  }
  return entry.rows[0].id;
}

describe("ledger health in the trial balance and accounting dashboard", () => {
  it("does not call an empty ledger balanced just because both totals are zero", async () => {
    const trial = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(trial.totals.closingDebit).toBe("0");
    expect(trial.totals.closingCredit).toBe("0");
    expect(trial.integrity.entryCount).toBe(0);
    expect(trial.integrity.unbalancedEntryCount).toBe(0);
    expect(trial.integrity.invalidEntryCount).toBe(0);
    // Two separate questions: the report has no activity to call balanced, and
    // the ledger has nothing to call healthy.
    expect(trial.trialBalanceBalanced).toBe(false);
    expect(trial.integrity.ledgerHealthy).toBe(false);

    const overview = await reports.getLedgerOverview(biz.id);
    expect(overview.totalDebit).toBe("0");
    expect(overview.totalCredit).toBe("0");
    expect(overview.journalEntryCount).toBe(0);
    expect(overview.balanced).toBe(false);
  });

  it("catches offsetting unbalanced entries even when the grand totals match", async () => {
    await postManualLines("سند خراب اول", [
      { accountId: acct.rent, debit: 100, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 90 },
    ]);
    await postManualLines("سند خراب دوم", [
      { accountId: acct.rent, debit: 90, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 100 },
    ]);

    const trial = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(trial.totals.closingDebit).toBe("190");
    expect(trial.totals.closingCredit).toBe("190");
    expect(trial.totals.closingDifference).toBe("0");
    expect(trial.integrity.balanceDifference).toBe("0");
    expect(trial.integrity.entryCount).toBe(2);
    expect(trial.integrity.unbalancedEntryCount).toBe(2);
    // The closing columns do match, but the books are not: one boolean would
    // have hidden two corrupt entries behind an equal grand total.
    expect(trial.trialBalanceBalanced).toBe(true);
    expect(trial.integrity.ledgerHealthy).toBe(false);

    const overview = await reports.getLedgerOverview(biz.id);
    expect(overview.totalDebit).toBe("190");
    expect(overview.totalCredit).toBe("190");
    expect(overview.unbalancedEntryCount).toBe(2);
    expect(overview.balanced).toBe(false);
  });

  it("flags a persisted journal header with no lines as invalid, not balanced", async () => {
    await db.query(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
       VALUES ($1, CURRENT_DATE, 'سند بدون ردیف', 'manual', $2)`,
      [biz.id, user.id],
    );

    const trial = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(trial.integrity.entryCount).toBe(1);
    expect(trial.integrity.lineCount).toBe(0);
    expect(trial.integrity.invalidEntryCount).toBe(1);
    expect(trial.trialBalanceBalanced).toBe(false);
    expect(trial.integrity.ledgerHealthy).toBe(false);
  });
});

describe("the accounting dashboard KPI buckets", () => {
  it("counts custom cash and bank sub-accounts inside the 1100–1130 block", async () => {
    const bank = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '1111', 'حساب بانک ملت', 'asset') RETURNING id`,
      [biz.id],
    );
    const capital = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '3100', 'سرمایه', 'equity') RETURNING id`,
      [biz.id],
    );

    await postManualLines("واریز سرمایه به بانک", [
      { accountId: bank.rows[0].id, debit: 500000, credit: 0 },
      { accountId: capital.rows[0].id, debit: 0, credit: 500000 },
    ]);

    const overview = await reports.getLedgerOverview(biz.id);
    expect(overview.balanced).toBe(true);
    expect(overview.cashAndBank).toBe("500000");
  });
});

describe("the trial balance and the accounting dashboard, after an account is archived", () => {
  it("keeps an archived account's postings and stays balanced", async () => {
    await postRentEntry();

    const before = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(before.trialBalanceBalanced).toBe(true);
    expect(before.totals.closingDebit).toBe("1000000");

    await accountsService.setAccountActive(biz.id, acct.rent, false, user.id);

    const after = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(after.trialBalanceBalanced).toBe(true);
    expect(after.totals.closingDebit).toBe("1000000");
    expect(after.totals.closingCredit).toBe("1000000");

    // Still listed, and flagged so the screen can say «بایگانی‌شده» rather than
    // silently omitting a Rial from the report.
    const rent = after.accounts.find((a) => a.code === "5300");
    expect(rent).toBeDefined();
    expect(rent!.isActive).toBe(false);
    expect(rent!.closingDebit).toBe("1000000");
    expect(rent!.closingCredit).toBe("0");

    const overview = await reports.getLedgerOverview(biz.id);
    expect(overview.balanced).toBe(true);
    expect(overview.expenses).toBe("1000000");
    expect(overview.cashAndBank).toBe("-1000000");
  });

  it("still leaves an archived account with no postings out of the report", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      // Not a WELL_KNOWN_CODE — those can never be archived at all.
      code: "5999",
      name: "حساب بی‌استفاده",
      type: "expense",
    });
    await accountsService.setAccountActive(biz.id, id, false, user.id);

    const balance = await reports.getTrialBalance(biz.id, FULL_REPORT_SCOPE);
    expect(balance.accounts.map((a) => a.code)).not.toContain("5999");
  });
});

describe("an installment plan's remaining balance", () => {
  it("is the unpaid slices, so a down payment does not leave a phantom balance", async () => {
    // 1,000,000 principal, 200,000 down, four slices of 200,000 and no interest.
    const { id } = await installments.createInstallmentPlan({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      source: "party",
      partyId: party.id,
      principal: 1000000,
      downPayment: 200000,
      installmentCount: 4,
      intervalMonths: 1,
      firstDueDate: "2026-01-10",
      createdBy: user.id,
    });

    const plan = await installments.getInstallmentPlan(biz.id, id);
    expect(plan).not.toBeNull();
    expect(plan!.scheduledTotal).toBe(800000);
    expect(plan!.remaining).toBe(800000);
    expect((plan!.items ?? []).map((i) => i.amount)).toEqual([
      200000, 200000, 200000, 200000,
    ]);

    // Settle every slice by hand — the point under test is the reported
    // balance, not the posting path (`payInstallmentItem` needs a full chart of
    // accounts, which `integration/ar.integration.test.ts` already covers).
    await db.query(
      `UPDATE installment_items SET paid_at = now(), paid_method = 'cash' WHERE installment_id = $1`,
      [id],
    );

    const settled = await installments.getInstallmentPlan(biz.id, id);
    expect(settled!.status).toBe("settled");
    // The old `principal - paidTotal` reported 200,000 still owing here — the
    // down payment, which is not a slice and was never going to be paid as one.
    expect(settled!.remaining).toBe(0);
  });

  it("counts interest, so the balance is the schedule's own total", async () => {
    const { id } = await installments.createInstallmentPlan({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      source: "party",
      partyId: party.id,
      principal: 1000000,
      interestPercent: 10,
      installmentCount: 2,
      intervalMonths: 1,
      firstDueDate: "2026-01-10",
      createdBy: user.id,
    });

    const plan = await installments.getInstallmentPlan(biz.id, id);
    expect(plan!.scheduledTotal).toBe(1100000);
    // `principal - paidTotal` would have said 1,000,000 — 100,000 of interest
    // the customer owes, missing from the number the screen shows them.
    expect(plan!.remaining).toBe(1100000);
    const accrued = await db.query<{ debit: string; credit: string }>(
      `SELECT COALESCE(sum(jl.debit), 0)::text AS debit, COALESCE(sum(jl.credit), 0)::text AS credit
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.source_type = 'installment_interest' AND je.source_id = $1`,
      [id],
    );
    expect(Number(accrued.rows[0].debit)).toBe(100000);
    expect(Number(accrued.rows[0].credit)).toBe(100000);

    await db.query(
      `UPDATE installment_items SET paid_at = now(), paid_method = 'cash' WHERE installment_id = $1 AND seq = 1`,
      [id],
    );
    const half = await installments.getInstallmentPlan(biz.id, id);
    expect(half!.remaining).toBe(550000);
    expect(half!.status).not.toBe("settled");
  });

  it("refuses a NaN interest percent instead of writing NaN slices", async () => {
    await expect(
      installments.createInstallmentPlan({
        businessId: biz.id,
        locationId: null,
        direction: "receivable",
        source: "party",
        partyId: party.id,
        principal: 1000000,
        // What `Number("۵")` produces, and what the route forwards verbatim.
        interestPercent: Number.NaN,
        installmentCount: 2,
        intervalMonths: 1,
        firstDueDate: "2026-01-10",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_percent");
  });

  it("refuses an impossible due date before PostgreSQL can raise a 500", async () => {
    await expect(
      installments.createInstallmentPlan({
        businessId: biz.id,
        locationId: null,
        direction: "receivable",
        source: "party",
        partyId: party.id,
        principal: 1000000,
        installmentCount: 2,
        intervalMonths: 1,
        firstDueDate: "2026-02-31",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_due_date");
  });

  it("settles a slice only once when two payment requests race", async () => {
    const { id } = await installments.createInstallmentPlan({
      businessId: biz.id,
      locationId: null,
      direction: "receivable",
      source: "party",
      partyId: party.id,
      principal: 500000,
      installmentCount: 1,
      intervalMonths: 1,
      firstDueDate: "2026-01-10",
      createdBy: user.id,
    });
    const plan = await installments.getInstallmentPlan(biz.id, id);
    const itemId = plan!.items![0].id;

    // Both requests succeed — the loser replays the winner's settlement, the
    // same retry semantic the payable side keeps — but exactly one receipt is
    // posted, stamped with the slice's deterministic key.
    await Promise.all([
      installments.payInstallmentItem({ businessId: biz.id, locationId: null, planId: id, itemId, method: "cash", createdBy: user.id }),
      installments.payInstallmentItem({ businessId: biz.id, locationId: null, planId: id, itemId, method: "cash", createdBy: user.id }),
    ]);
    const receipts = await db.query<{ count: string; idempotency_key: string; request_fingerprint: string }>(
      "SELECT count(*)::text AS count, min(idempotency_key) AS idempotency_key, min(request_fingerprint) AS request_fingerprint FROM ar_receipts WHERE business_id = $1 AND customer_id = $2",
      [biz.id, party.id],
    );
    expect(Number(receipts.rows[0].count)).toBe(1);
    expect(receipts.rows[0].idempotency_key).toBe(`installment-ar:${id}:${itemId}`);
    expect(receipts.rows[0].request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // A retry with changed intent is a conflict, not a replay.
    await expect(
      installments.payInstallmentItem({ businessId: biz.id, locationId: null, planId: id, itemId, method: "bank", createdBy: user.id }),
    ).rejects.toThrow("idempotency_conflict");
  });

  it("allows only one installment plan for each credit invoice", async () => {
    const location = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه اقساط') RETURNING id`,
      [biz.id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, customer_id, subtotal, total, closed_at)
       VALUES ($1, 2, 'retail', 'completed', $2, 500000, 500000, now()) RETURNING id`,
      [location.rows[0].id, party.id],
    );
    await db.query(
      `INSERT INTO payments (order_id, location_id, method, amount) VALUES ($1, $2, 'credit', 500000)`,
      [order.rows[0].id, location.rows[0].id],
    );
    const input = {
      businessId: biz.id,
      locationId: location.rows[0].id,
      direction: "receivable" as const,
      source: "invoice" as const,
      invoiceOrderId: order.rows[0].id,
      principal: 500000,
      installmentCount: 2,
      intervalMonths: 1,
      firstDueDate: "2026-01-10",
      createdBy: user.id,
    };

    await installments.createInstallmentPlan(input);
    await expect(installments.createInstallmentPlan(input)).rejects.toThrow("invoice_already_scheduled");
  });

  it("refuses an invoice that was not sold on credit", async () => {
    // A cash-settled retail invoice has no receivable to schedule: its slices
    // would credit A/R against a debit that never happened.
    const location = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه') RETURNING id`,
      [biz.id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, customer_id, subtotal, total, closed_at)
       VALUES ($1, 1, 'retail', 'completed', $2, 500000, 500000, now()) RETURNING id`,
      [location.rows[0].id, party.id],
    );
    await db.query(
      `INSERT INTO payments (order_id, location_id, method, amount) VALUES ($1, $2, 'cash', 500000)`,
      [order.rows[0].id, location.rows[0].id],
    );

    await expect(
      installments.createInstallmentPlan({
        businessId: biz.id,
        locationId: location.rows[0].id,
        direction: "receivable",
        source: "invoice",
        invoiceOrderId: order.rows[0].id,
        // Derived from the order server-side; the wizard sends the invoice total.
        principal: 500000,
        installmentCount: 2,
        intervalMonths: 1,
        firstDueDate: "2026-01-10",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invoice_not_on_credit");
  });

  it("answers party_not_found for a non-uuid party id rather than crashing", async () => {
    await expect(
      installments.createInstallmentPlan({
        businessId: biz.id,
        locationId: null,
        direction: "receivable",
        source: "party",
        // The sentinel the A/R balance list uses for unattributed lines. Handed
        // to a uuid column it raises a Postgres syntax error, not "no such row".
        partyId: "unknown",
        principal: 1000000,
        installmentCount: 2,
        intervalMonths: 1,
        firstDueDate: "2026-01-10",
        createdBy: user.id,
      }),
    ).rejects.toThrow("party_not_found");
  });
});

describe("overview P&L semantics (#912 items 3, 4, 6)", () => {
  async function seedFiscalYear(label: string, from: string, to: string, closed = false) {
    const year = await db.query<{ id: string }>(
      `INSERT INTO fiscal_years (business_id, label, starts_on, ends_on, closed_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() ELSE NULL END) RETURNING id`,
      [biz.id, label, from, to, closed],
    );
    // Monthly periods: once a year exists the posting trigger requires every
    // new entry to be covered, even a back-dated one.
    await db.query(
      `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
       SELECT $1, $2, $3::text || '-' || to_char(g, 'MM'), g::date,
              (g + interval '1 month' - interval '1 day')::date
         FROM generate_series($4::date, $4::date + interval '11 months', interval '1 month') g`,
      [biz.id, year.rows[0].id, label, from],
    );
  }
  async function seedRetained() {
    const r = await db.query<{ id: string }>(
      "INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '3200', 'سود انباشته', 'equity') RETURNING id",
      [biz.id],
    );
    return r.rows[0].id;
  }

  it("closed year retains revenue/expenses and ties out to the pre-close income statement", async () => {
    await seedFiscalYear("1404", "2025-01-01", "2025-12-31");
    const retained = await seedRetained();
    await postManualLines("فروش", [{ accountId: acct.cash, debit: 1_000_000, credit: 0 }, { accountId: acct.revenue, debit: 0, credit: 1_000_000 }], "2025-03-01");
    await postManualLines("اجاره", [{ accountId: acct.rent, debit: 400_000, credit: 0 }, { accountId: acct.cash, debit: 0, credit: 400_000 }], "2025-04-01");

    const reportsService = await import("../src/lib/reports-service");
    const { BUSINESS_WIDE_SCOPE } = await import("../src/lib/report-scope");
    const pnl = await reportsService.getProfitAndLoss(biz.id, { dateFrom: "2025-01-01", dateTo: "2025-12-31" }, BUSINESS_WIDE_SCOPE);
    const midYear = await reports.getLedgerOverview(biz.id, { asOfDate: "2025-06-30" });
    expect(midYear.scope).toMatchObject({ period: "fiscal_year", fiscalYearLabel: "1404" });
    expect(midYear.revenue).toBe(String(pnl.totalRevenue));
    expect(midYear.expenses).toBe(String(pnl.totalExpenses));
    expect(midYear.netIncome).toBe(String(pnl.netIncome));

    // The year-end closing entry zeroing revenue/expense into retained earnings.
    await postManualLines("بستن سال", [
      { accountId: acct.revenue, debit: 1_000_000, credit: 0 },
      { accountId: acct.rent, debit: 0, credit: 400_000 },
      { accountId: retained, debit: 0, credit: 600_000 },
    ], "2025-12-31", "closing");

    const afterClose = await reports.getLedgerOverview(biz.id, { asOfDate: "2025-12-31" });
    expect(afterClose.revenue).toBe("1000000");
    expect(afterClose.expenses).toBe("400000");
    expect(afterClose.netIncome).toBe("600000");
    expect(afterClose.cashAndBank).toBe("600000");
  });

  it("cross-year selection reports only the selected year; reversals net out", async () => {
    await seedFiscalYear("1404", "2025-01-01", "2025-12-31");
    await seedFiscalYear("1405", "2026-01-01", "2026-12-31");
    await postManualLines("فروش ۱۴۰۴", [{ accountId: acct.cash, debit: 1_000_000, credit: 0 }, { accountId: acct.revenue, debit: 0, credit: 1_000_000 }], "2025-05-01");
    await postManualLines("فروش ۱۴۰۵", [{ accountId: acct.cash, debit: 200_000, credit: 0 }, { accountId: acct.revenue, debit: 0, credit: 200_000 }], "2026-02-01");
    // A reversal of part of the 1405 sale, posted as the mirror entry.
    await postManualLines("برگشت فروش", [{ accountId: acct.revenue, debit: 50_000, credit: 0 }, { accountId: acct.cash, debit: 0, credit: 50_000 }], "2026-02-10");

    const y2026 = await reports.getLedgerOverview(biz.id, { asOfDate: "2026-03-01" });
    expect(y2026.scope.fiscalYearLabel).toBe("1405");
    expect(y2026.revenue).toBe("150000");
    // Balance-sheet tiles are as-of: they carry both years.
    expect(y2026.cashAndBank).toBe("1150000");
    const y2025 = await reports.getLedgerOverview(biz.id, { asOfDate: "2025-12-31" });
    expect(y2025.revenue).toBe("1000000");
  });

  it("future-dated journals do not change current balances", async () => {
    await postManualLines("فروش آینده", [{ accountId: acct.cash, debit: 9_000_000, credit: 0 }, { accountId: acct.revenue, debit: 0, credit: 9_000_000 }], "2999-01-01");
    const now = await reports.getLedgerOverview(biz.id, { asOfDate: "2026-01-15" });
    expect(now.cashAndBank).toBe("0");
    expect(now.revenue).toBe("0");
    const future = await reports.getLedgerOverview(biz.id, { asOfDate: "2999-01-01" });
    expect(future.cashAndBank).toBe("9000000");
  });

  it("cross-tenant: another business's overview sees none of these books", async () => {
    await postManualLines("فروش", [{ accountId: acct.cash, debit: 700_000, credit: 0 }, { accountId: acct.revenue, debit: 0, credit: 700_000 }], "2026-01-10");
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other', $1) RETURNING id",
      [`other-${Math.random().toString(36).slice(2, 8)}`],
    );
    const theirs = await reports.getLedgerOverview(other.rows[0].id, { asOfDate: "2026-12-31" });
    expect(theirs.journalEntryCount).toBe(0);
    expect(theirs.cashAndBank).toBe("0");
    expect(theirs.revenue).toBe("0");
  });

  async function seedSaleLine(opts: { status: string; qty: number; returned: number; net: number; itemStatus?: string }) {
    const loc = await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'Web') RETURNING id", [biz.id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
       VALUES ($1, 1, 'retail', 'open', $2, now()) RETURNING id`, [loc.rows[0].id, opts.net],
    );
    const item = await db.query<{ id: string }>(
      `INSERT INTO order_items (location_id, order_id, name_snapshot, quantity, unit_price, status)
       VALUES ($1, $2, 'کالا', $3, 1000, $4) RETURNING id`,
      [loc.rows[0].id, order.rows[0].id, opts.qty, opts.itemStatus ?? "served"],
    );
    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1", [order.rows[0].id]);
    await db.query(
      `INSERT INTO online_sale_lines (order_item_id, order_id, location_id, source_type, quantity, net_rial, cost_status, stock_outcome, returned_quantity, occurred_at)
       VALUES ($1, $2, $3, 'woocommerce_order', $4, $5, $6, 'legacy', $7, now())`,
      [item.rows[0].id, order.rows[0].id, loc.rows[0].id, opts.qty, opts.net, opts.status, opts.returned],
    );
    return { locationId: loc.rows[0].id, orderId: order.rows[0].id, itemId: item.rows[0].id };
  }

  it("online-cost exposure: missing/partial, returns, duplicate refund, retroactive attribution", async () => {
    const missing = await seedSaleLine({ status: "missing", qty: 2, returned: 0, net: 100_000 });
    await seedSaleLine({ status: "partial", qty: 4, returned: 1, net: 100_000 });
    await seedSaleLine({ status: "missing", qty: 1, returned: 1, net: 50_000 }); // fully returned
    await seedSaleLine({ status: "missing", qty: 1, returned: 0, net: 70_000, itemStatus: "voided" });

    let overview = await reports.getLedgerOverview(biz.id);
    expect(overview.costCoverage.uncostedLines).toBe(2);
    expect(overview.costCoverage.uncostedNetRial).toBe("175000"); // 100k + 75k prorated
    expect(overview.costCoverage.affected.map((a) => a.orderId)).toContain(missing.orderId);

    // Duplicate refund delivery: the capped update is idempotent, exposure unchanged.
    for (let i = 0; i < 2; i++) {
      await db.query(
        "UPDATE online_sale_lines SET returned_quantity = LEAST(quantity, returned_quantity + 1) WHERE order_item_id = $1",
        [missing.itemId],
      );
    }
    overview = await reports.getLedgerOverview(biz.id);
    expect(overview.costCoverage.uncostedNetRial).toBe("75000"); // missing now fully returned once-capped… qty2 returned capped at 2 → 0 + 75k

    // Retroactive cost attribution clears the remaining line.
    await db.query("UPDATE online_sale_lines SET cost_status = 'known' WHERE cost_status = 'partial'");
    overview = await reports.getLedgerOverview(biz.id);
    expect(overview.costCoverage.provisional).toBe(false);
    expect(overview.costCoverage.uncostedNetRial).toBe("0");
  });
});
