/**
 * The Expenses register as an accounting subledger (issue #832).
 *
 * Phase 16's scope line promised "categorised operating expenses with
 * attachments, recurring expenses, and their postings". Of those three, the
 * postings core was built, attachments landed later (0177's Media Library
 * receipt), and recurring expenses never did — and this file is where each of
 * those claims is either demonstrated or contradicted by the database itself.
 *
 * What is proven here, in the order the issue lists it:
 *
 *   §1  a posted expense is corrected by a *reversal* — a second, separately
 *       numbered row whose journal mirrors the first — so the register and the
 *       General Ledger net to zero together, both rows stay visible, a second
 *       reversal is refused, and a reversal of a reversal is refused by a CHECK;
 *   §2  only cash-shaped accounts may be credited (inventory, receivables and
 *       recoverable VAT are refused even though they are assets);
 *   §5  the future-date rule is the service's, not the browser's;
 *   §6  a branch is recorded, filterable and re-labelled, and a foreign branch id
 *       is a refusal rather than a widened query;
 *   §9  keyset paging: a page cannot shift under a reader when a new expense is
 *       posted between requests;
 *   §11 input VAT posts three lines and reverses on the same three accounts;
 *   §12 an expense outlives the party it named, keeping its free-text vendor;
 *   §15/§21 the reference counter, and the AI/import channels reaching the same
 *       `recordExpense` rules.
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
let expenseService: typeof import("../src/lib/expense-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const acct = {
  cash: "",
  clearing: "",
  petty: "",
  receivable: "",
  vat: "",
  inventory: "",
  rent: "",
  revenue: "",
  branchA: "",
  branchB: "",
};
const user = { id: "" };

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
  databaseName = `pos_expense_${randomUUID().replaceAll("-", "")}`;

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
  expenseService = await import("../src/lib/expense-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");

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
  await db.query("DELETE FROM expenses");
  await db.query("DELETE FROM media_assets");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Expense Co', $1) RETURNING id",
    [`expense-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  // The reference counter is per business and monotonic; without this the
  // numbering assertions below would depend on how many tests ran first.
  await db.query("DELETE FROM expense_reference_counters");
  await db.query("DELETE FROM parties");
  await db.query("DELETE FROM locations");

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES
       ($1, '1100', 'Cash', 'asset'),
       ($1, '1120', 'Card settlement', 'asset'),
       ($1, '1130', 'Petty cash', 'asset'),
       ($1, '1200', 'Accounts receivable', 'asset'),
       ($1, '1220', 'Input VAT', 'asset'),
       ($1, '1500', 'Inventory', 'asset'),
       ($1, '5300', 'Rent', 'expense'),
       ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.clearing = r.id;
    if (r.code === "1130") acct.petty = r.id;
    if (r.code === "1200") acct.receivable = r.id;
    if (r.code === "1220") acct.vat = r.id;
    if (r.code === "1500") acct.inventory = r.id;
    if (r.code === "5300") acct.rent = r.id;
    if (r.code === "4300") acct.revenue = r.id;
  }

  // Two branches: §6 needs a register that can tell them apart, and one that a
  // member of a *different* business can try to point at.
  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Center', 'Asia/Tehran', true),
            ($1, 'North branch', 'Asia/Tehran', true)
     RETURNING id, name`,
    [biz.id],
  );
  acct.branchA = locations.rows[0].id;
  acct.branchB = locations.rows[1].id;
});

describe("recordExpense", () => {
  it("posts a balanced entry: debit the expense account, credit the payment account", async () => {
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 500_000,
      expenseDate: "2025-04-15",
      vendor: "Landlord Co",
      memo: "Monthly rent",
      createdBy: user.id,
    });
    expect(expense.amount).toBe(500_000);
    expect(expense.vendor).toBe("Landlord Co");

    const { rows: entries } = await db.query(
      `SELECT source_type, source_id, entry_date::text AS entry_date, memo FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source_type: "expense", source_id: expense.id, entry_date: "2025-04-15", memo: "Monthly rent" });

    const { rows: lines } = await db.query(
      `SELECT account_id, debit, credit FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.business_id = $1 ORDER BY debit DESC`,
      [biz.id],
    );
    expect(lines).toEqual([
      { account_id: acct.rent, debit: "500000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "500000" },
    ]);
  });

  it("appears in listExpenses with account and payment-account names", async () => {
    await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 200_000,
      memo: "Utilities",
      createdBy: user.id,
    });
    const list = await expenseService.listExpenses(biz.id);
    expect(list.expenses).toHaveLength(1);
    expect(list.expenses[0]).toMatchObject({ accountCode: "5300", paymentAccountCode: "1100", amount: 200_000, memo: "Utilities" });
    expect(list).toMatchObject({ hasMore: false, totalAmount: 200_000, totalCount: 1 });
  });

  it("filters by date range, category and free text, and totals the whole match", async () => {
    const common = { businessId: biz.id, locationId: null, paymentAccountId: acct.cash, createdBy: user.id };
    await expenseService.recordExpense({ ...common, accountId: acct.rent, amount: 100_000, expenseDate: "2025-01-10", memo: "January rent", vendor: "Landlord" });
    await expenseService.recordExpense({ ...common, accountId: acct.rent, amount: 300_000, expenseDate: "2025-06-10", memo: "June rent", vendor: "Landlord" });

    const ranged = await expenseService.listExpenses(biz.id, { dateFrom: "2025-05-01", dateTo: "2025-12-31" });
    expect(ranged.expenses.map((e) => e.memo)).toEqual(["June rent"]);
    expect(ranged.totalAmount).toBe(300_000);
    expect(ranged.totalCount).toBe(1);

    const searched = await expenseService.listExpenses(biz.id, { q: "january" });
    expect(searched.expenses.map((e) => e.memo)).toEqual(["January rent"]);

    const byCategory = await expenseService.listExpenses(biz.id, { accountId: acct.rent });
    expect(byCategory.totalCount).toBe(2);
    expect(byCategory.totalAmount).toBe(400_000);

    // The total must describe the whole match, not the returned page — the bug
    // the old client-side `reduce` over a silently truncated list had.
    const paged = await expenseService.listExpenses(biz.id, { limit: 1 });
    expect(paged.expenses).toHaveLength(1);
    expect(paged.hasMore).toBe(true);
    expect(paged.totalCount).toBe(2);
    expect(paged.totalAmount).toBe(400_000);
  });

  it("rejects an impossible expense date instead of letting Postgres 500", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        expenseDate: "2025-02-31",
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_expense_date");
  });

  it("rejects a non-expense account as the category", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.revenue,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_expense_account");
  });

  it("rejects a non-asset account as the payment source", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.revenue,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_payment_account");
  });

  it("rejects the same account on both sides", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.rent,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("same_account");
  });

  it("rejects a zero or negative amount, and an empty memo", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 0,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_amount");
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "  ",
        createdBy: user.id,
      }),
    ).rejects.toThrow("memo_required");
  });

  it("rejects an account from a different business", async () => {
    const other = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id", [
      `other-${randomUUID().slice(0, 8)}`,
    ]);
    const otherAccount = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5300', 'Rent', 'expense') RETURNING id`,
      [other.rows[0].id],
    );
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: otherAccount.rows[0].id,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("unknown_account");
  });

  it("rejects posting into a locked fiscal period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", user.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", user.id);

    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        expenseDate: farvardin.startsOn,
        memo: "X",
        createdBy: user.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});

/**
 * Migration 0177 closes the "attachments... are deferred" gap this test file
 * opens with: a receipt photo is a real Media Library asset, and an expense
 * can point at the one it was recorded from. `receiptAssetId` must be
 * tenant-scoped like every other cross-reference here (`unknown_account`'s
 * sibling), and the FK's `ON DELETE SET NULL` must survive the asset it
 * points at actually being deleted — the expense outlives its receipt photo.
 */
describe("recordExpense — receipt asset (migration 0177)", () => {
  async function insertAsset(businessId: string, fileName = "receipt.jpg"): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_assets (business_id, kind, file_name, mime_type, byte_size, storage_key, sha256)
       VALUES ($1, 'image', $2, 'image/jpeg', 1024, $3, repeat('b', 64)) RETURNING id`,
      [businessId, fileName, `media/${businessId}/${randomUUID()}/${fileName}`],
    );
    return rows[0].id;
  }

  it("links the expense to the receipt asset and getMediaAssetUsage finds it back", async () => {
    const assetId = await insertAsset(biz.id);
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 250_000,
      memo: "خرید از روی رسید",
      createdBy: user.id,
      receiptAssetId: assetId,
    });
    expect(expense.receiptAssetId).toBe(assetId);

    const { rows } = await db.query<{ receipt_asset_id: string }>(
      "SELECT receipt_asset_id FROM expenses WHERE id = $1",
      [expense.id],
    );
    expect(rows[0].receipt_asset_id).toBe(assetId);

    const mediaService = await import("../src/lib/media-service");
    const usage = await mediaService.getMediaAssetUsage(assetId);
    expect(usage.expenses).toEqual([{ id: expense.id, name: "خرید از روی رسید" }]);
    expect(mediaService.mediaAssetUsageIsEmpty(usage)).toBe(false);
  });

  it("rejects a receipt asset belonging to a different business", async () => {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Receipt Co', $1) RETURNING id",
      [`other-receipt-${randomUUID().slice(0, 8)}`],
    );
    const foreignAssetId = await insertAsset(other.rows[0].id);

    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
        receiptAssetId: foreignAssetId,
      }),
    ).rejects.toThrow("receipt_asset_not_found");
  });

  it("rejects a receiptAssetId that does not exist at all", async () => {
    await expect(
      expenseService.recordExpense({
        businessId: biz.id,
        locationId: null,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "X",
        createdBy: user.id,
        receiptAssetId: randomUUID(),
      }),
    ).rejects.toThrow("receipt_asset_not_found");
  });

  it("survives the receipt asset later being deleted — the expense keeps its amount, just loses the link", async () => {
    const assetId = await insertAsset(biz.id);
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 90_000,
      memo: "قابل حذف",
      createdBy: user.id,
      receiptAssetId: assetId,
    });

    await db.query("DELETE FROM media_assets WHERE id = $1", [assetId]);

    const { rows } = await db.query<{ amount: string; receipt_asset_id: string | null }>(
      "SELECT amount, receipt_asset_id FROM expenses WHERE id = $1",
      [expense.id],
    );
    expect(rows[0].receipt_asset_id).toBeNull();
    expect(rows[0].amount).toBe("90000");
  });
});

/**
 * §1 — the correction model. Read as a set, these eight cases are the difference
 * between "the register disagreed with the ledger forever" and the two books
 * being the same fact twice: a reversal is a *new* row that mirrors the old
 * entry line for line, the original is annotated and never edited, and the
 * database itself (a partial unique index and two CHECKs) is what makes the
 * double-reversal and reverse-the-reversal cases impossible rather than merely
 * discouraged.
 */
describe("reverseExpense (issue #832 §1)", () => {
  async function rentExpense(amount = 5_000_000) {
    return expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount,
      expenseDate: "2025-04-15",
      memo: "Monthly rent",
      createdBy: user.id,
    });
  }

  /**
   * `open → soft_closed → locked` is the lifecycle the fiscal calendar enforces
   * (see `canTransitionPeriod`), so a test that wants a locked period has to walk
   * it the same way the UI does.
   */
  async function lockPeriod(periodId: string) {
    await fiscalService.setPeriodStatus(biz.id, periodId, "soft_closed", user.id);
    await fiscalService.setPeriodStatus(biz.id, periodId, "locked", user.id);
  }

  async function netByAccount() {
    const { rows } = await db.query<{ account_id: string; net: string }>(
      `SELECT jl.account_id, SUM(jl.debit - jl.credit)::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 GROUP BY 1`,
      [biz.id],
    );
    return Object.fromEntries(rows.map((r) => [r.account_id, Number(r.net)]));
  }

  it("nets the expense account, the payment account and the register itself to zero", async () => {
    const original = await rentExpense();
    const reversal = await expenseService.reverseExpense({
      businessId: biz.id,
      expenseId: original.id,
      actorId: user.id,
    });

    // The reversal is a *positive* row of its own — the sign lives in the journal
    // (its lines are the mirror) and in the register's totals, which subtract it.
    // Storing a negative row instead would make the register a place where a
    // correction is invisible except as a weird minus.
    expect(reversal.amount).toBe(5_000_000);
    expect(reversal.netAmount).toBe(5_000_000);
    expect(reversal.status).toBe("reversal");
    expect(reversal.reversesExpenseId).toBe(original.id);

    // The ledger half: both accounts back where they started, four lines in total.
    const net = await netByAccount();
    expect(net[acct.rent]).toBe(0);
    expect(net[acct.cash]).toBe(0);
    const { rows: lines } = await db.query("SELECT id FROM journal_lines");
    expect(lines).toHaveLength(4);

    // …and the register half, which is the actual bug: the sum of the book.
    const list = await expenseService.listExpenses(biz.id);
    expect(list.totalCount).toBe(2);
    expect(list.totalAmount).toBe(0);
    expect(list.totalPaidAmount).toBe(0);
    // The three states §1 asked the register to distinguish: this pair reads
    // `reversed` (the original, annotated) and `reversal` (the correcting row).
    expect(list.expenses.map((e) => e.status).sort()).toEqual(["reversal", "reversed"]);
    expect(list.expenses.find((e) => e.status === "reversed")?.memo).toBe("Monthly rent");
  });

  it("annotates the original and leaves its history alone", async () => {
    const original = await rentExpense();
    const before = await db.query<{ memo: string; amount: string; expense_date: string; created_at: string }>(
      "SELECT memo, amount::text, expense_date::text, created_at::text FROM expenses WHERE id = $1",
      [original.id],
    );

    const reversal = await expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id });

    const after = await db.query<{ memo: string; amount: string; expense_date: string; created_at: string }>(
      "SELECT memo, amount::text, expense_date::text, created_at::text FROM expenses WHERE id = $1",
      [original.id],
    );
    // Not one field of the posted record moved. A correction is a second fact
    // beside the first, which is what an audit needs to be able to reconstruct.
    expect(after.rows[0]).toEqual(before.rows[0]);

    const { rows } = await db.query<{ reversed_at: string | null; reversed_by: string | null }>(
      "SELECT reversed_at::text, reversed_by FROM expenses WHERE id = $1",
      [original.id],
    );
    expect(rows[0].reversed_at).not.toBeNull();
    expect(rows[0].reversed_by).toBe(user.id);

    // Both directions of the link, so either row explains the other.
    const reloaded = await expenseService.getExpense(biz.id, original.id);
    expect(reloaded?.status).toBe("reversed");
    expect(reloaded?.reversalExpenseId).toBe(reversal.id);
    expect(reloaded?.reversalReference).toBe(reversal.reference);
    expect(reversal.reversesExpenseReference).toBe(original.reference);
  });

  it("refuses a second reversal of the same expense", async () => {
    const original = await rentExpense();
    await expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id });
    await expect(
      expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id }),
    ).rejects.toThrow("expense_already_reversed");

    // And the row count says the refusal was real: still one reversal, no second
    // entry, no half-written pair.
    const { rows } = await db.query<{ count: string }>(
      "SELECT COUNT(*)::text FROM expenses WHERE reverses_expense_id = $1",
      [original.id],
    );
    expect(rows[0].count).toBe("1");
  });

  it("refuses to reverse a reversal, in the service and in the schema", async () => {
    const original = await rentExpense();
    const reversal = await expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id });
    await expect(
      expenseService.reverseExpense({ businessId: biz.id, expenseId: reversal.id, actorId: user.id }),
    ).rejects.toThrow("expense_is_reversal");

    // The policy is a CHECK, so a writer that skips the service cannot create the
    // loop the service refused: `reversed_at` on a reversal row is rejected.
    await expect(
      db.query("UPDATE expenses SET reversed_at = now() WHERE id = $1", [reversal.id]),
    ).rejects.toThrow(/expenses_reversal_is_final|violates check constraint/);
  });

  it("dates the reversal today and refuses to backdate it into a locked period", async () => {
    const original = await rentExpense();
    // 1404/01 is *last* Jalali year: the original sits there, the correction does
    // not belong there.
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await lockPeriod(farvardin.id);

    // Backdating a correction into the locked month is refused by the same trigger
    // every other posting path obeys — and it refuses the *attempt*, not the book:
    // the original is still open for correction afterwards.
    await expect(
      expenseService.reverseExpense({
        businessId: biz.id,
        expenseId: original.id,
        actorId: user.id,
        reversalDate: farvardin.startsOn,
      }),
    ).rejects.toThrow("fiscal_period_locked");
    const { rows: untouched } = await db.query<{ reversed_at: string | null }>(
      "SELECT reversed_at FROM expenses WHERE id = $1",
      [original.id],
    );
    expect(untouched[0].reversed_at).toBeNull();

    // A default-dated reversal lands on the business's today, which is open: a
    // correction is never held hostage by a closed historical period.
    const reversal = await expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id });
    expect(reversal.expenseDate).not.toBe("2025-04-15");
    const { todayIsoDate } = await import("../src/lib/jalali");
    const { rows: [tenant] } = await db.query<{ timezone: string | null }>(
      "SELECT timezone FROM businesses WHERE id = $1",
      [biz.id],
    );
    expect(reversal.expenseDate).toBe(todayIsoDate(tenant.timezone ?? undefined));
  });

  it("reverses input VAT on the very account it was charged to", async () => {
    const expense = await expenseService.recordExpense({
      businessId: biz.id,
      locationId: null,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 1_100_000,
      vatAmount: 100_000,
      expenseDate: "2025-04-15",
      memo: "VAT-bearing rent",
      createdBy: user.id,
    });
    expect(expense.vatAmount).toBe(100_000);

    const reversal = await expenseService.reverseExpense({ businessId: biz.id, expenseId: expense.id, actorId: user.id });
    expect(reversal.vatAmount).toBe(100_000);

    // Netted by the register: the VAT the business can claim is back to zero, and
    // so is the cash it paid — the same three accounts the original touched.
    const totals = await expenseService.listExpenses(biz.id);
    expect(totals.totalVatAmount).toBe(0);
    expect(totals.totalAmount).toBe(0);
    expect(totals.totalPaidAmount).toBe(0);

    const net = await db.query<{ account_id: string; net: string }>(
      `SELECT jl.account_id, SUM(jl.debit - jl.credit)::text AS net
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1 GROUP BY 1 HAVING SUM(jl.debit - jl.credit) <> 0`,
      [biz.id],
    );
    // Three accounts touched, zero net movement on all three — because the
    // reversal reads the original's own lines rather than re-deriving them.
    expect(net.rows).toEqual([]);
  });

  it("refuses a record it does not own, and one that does not exist", async () => {
    const original = await rentExpense();
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Reversal Co', $1) RETURNING id",
      [`other-reversal-${randomUUID().slice(0, 8)}`],
    );
    await expect(
      expenseService.reverseExpense({ businessId: other.rows[0].id, expenseId: original.id, actorId: user.id }),
    ).rejects.toThrow("expense_not_found");
    await expect(
      expenseService.reverseExpense({ businessId: biz.id, expenseId: randomUUID(), actorId: user.id }),
    ).rejects.toThrow("expense_not_found");
    // The refusal left the original alone.
    const { rows } = await db.query<{ reversed_at: string | null }>("SELECT reversed_at FROM expenses WHERE id = $1", [
      original.id,
    ]);
    expect(rows[0].reversed_at).toBeNull();
  });

  it("rolls the whole correction back when the posting fails", async () => {
    const original = await rentExpense();
    // Lock today's period: the reversal's own date is refused, so neither the new
    // row nor its annotation may survive — the expense must come back as if the
    // attempt never happened.
    await fiscalService.createFiscalYear(biz.id, 1405);
    const today = new Date().toISOString().slice(0, 10);
    const years = await fiscalService.listFiscalYears(biz.id);
    const thisYear = years.find((y) => y.startsOn <= today && today <= y.endsOn) ?? years[years.length - 1];
    const periods = await fiscalService.listPeriods(biz.id, thisYear.id);
    const current = periods.find((per) => per.startsOn <= today && today <= per.endsOn) ?? periods[periods.length - 1];
    await lockPeriod(current.id);

    await expect(
      expenseService.reverseExpense({ businessId: biz.id, expenseId: original.id, actorId: user.id }),
    ).rejects.toThrow();

    const { rows } = await db.query<{ expenses: string; lines: string; reversed: string }>(
      `SELECT (SELECT COUNT(*)::text FROM expenses) AS expenses,
              (SELECT COUNT(*)::text FROM journal_lines) AS lines,
              (SELECT COUNT(*)::text FROM expenses WHERE reversed_at IS NOT NULL) AS reversed`,
    );
    expect(rows[0]).toEqual({ expenses: "1", lines: "2", reversed: "0" });
  });
});

describe("the register's own semantics (issue #832 §2, §5, §6, §9, §11, §12, §21)", () => {
  const base = () => ({ businessId: biz.id, locationId: null, accountId: acct.rent, createdBy: user.id });

  it("credits cash, petty cash and card settlement — and nothing else that is an asset", async () => {
    for (const paymentAccountId of [acct.cash, acct.clearing, acct.petty]) {
      await expect(
        expenseService.recordExpense({ ...base(), paymentAccountId, amount: 10_000, memo: "ok", expenseDate: "2025-04-15" }),
      ).resolves.toMatchObject({ paymentAccountId });
    }
    // The four the audit named as reachable before this fix.
    for (const [id, label] of [
      [acct.inventory, "inventory"],
      [acct.receivable, "accounts receivable"],
      [acct.vat, "input VAT"],
      [acct.revenue, "revenue"],
    ] as const) {
      await expect(
        expenseService.recordExpense({ ...base(), paymentAccountId: id, amount: 10_000, memo: label, expenseDate: "2025-04-15" }),
      ).rejects.toThrow("invalid_payment_account");
    }
  });

  it("refuses a future date in the service, not only in the browser", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(
      expenseService.recordExpense({ ...base(), paymentAccountId: acct.cash, amount: 10_000, memo: "ahead", expenseDate: future }),
    ).rejects.toThrow("expense_date_in_future");
    // Backdating is allowed — that is a fiscal-period question, per period, per role.
    await expect(
      expenseService.recordExpense({ ...base(), paymentAccountId: acct.cash, amount: 10_000, memo: "back", expenseDate: "2020-01-01" }),
    ).resolves.toMatchObject({ expenseDate: "2020-01-01" });
  });

  it("defaults the date to the business's own today", async () => {
    const expense = await expenseService.recordExpense({
      ...base(),
      paymentAccountId: acct.cash,
      amount: 10_000,
      memo: "no date typed",
    });
    // Not UTC's today, and not the browser's: the business timezone decides.
    const { rows } = await db.query<{ tz: string | null }>("SELECT timezone FROM businesses WHERE id = $1", [biz.id]);
    const { todayIsoDate } = await import("../src/lib/jalali");
    expect(expense.expenseDate).toBe(todayIsoDate(rows[0].tz ?? undefined));
  });

  it("records, filters and labels the branch that incurred it", async () => {
    const common = { ...base(), paymentAccountId: acct.cash, expenseDate: "2025-04-15" };
    await expenseService.recordExpense({ ...common, amount: 100_000, memo: "Center rent", locationId: acct.branchA });
    await expenseService.recordExpense({ ...common, amount: 300_000, memo: "North rent", locationId: acct.branchB });
    await expenseService.recordExpense({ ...common, amount: 50_000, memo: "Business-wide" });

    const all = await expenseService.listExpenses(biz.id);
    expect(all.totalCount).toBe(3);
    expect(all.totalAmount).toBe(450_000);

    const north = await expenseService.listExpenses(biz.id, { locationId: acct.branchB });
    expect(north.expenses.map((e) => e.memo)).toEqual(["North rent"]);
    expect(north.totalAmount).toBe(300_000);
    expect(north.expenses[0].locationName).toBe("North branch");

    // A filter on an id this business does not own returns nothing, rather than
    // widening to "all branches" — the one silent failure that would look like a
    // correct answer. (The write side of the same rule is the next case.)
    const missing = await expenseService.listExpenses(biz.id, { locationId: randomUUID() });
    expect(missing.totalCount).toBe(0);
    expect(missing.totalAmount).toBe(0);
  });

  it("rejects a location from another business rather than mis-filing it", async () => {
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Location Co', $1) RETURNING id",
      [`other-loc-${randomUUID().slice(0, 8)}`],
    );
    const otherLocation = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, timezone, is_active) VALUES ($1, 'Their branch', 'Asia/Tehran', true) RETURNING id`,
      [otherBiz.rows[0].id],
    );
    await expect(
      expenseService.recordExpense({
        ...base(),
        paymentAccountId: acct.cash,
        amount: 10_000,
        memo: "not ours",
        locationId: otherLocation.rows[0].id,
      }),
    ).rejects.toThrow("invalid_location");
  });

  it("pages a keyset that does not shift when a row is posted mid-read", async () => {
    const common = { ...base(), paymentAccountId: acct.cash, expenseDate: "2025-04-15" };
    for (let i = 1; i <= 5; i += 1) {
      await expenseService.recordExpense({ ...common, amount: i * 1000, memo: `row ${i}` });
    }
    const first = await expenseService.listExpenses(biz.id, { limit: 2 });
    expect(first.expenses.map((e) => e.memo)).toEqual(["row 5", "row 4"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeTruthy();

    // Everything the same date, so `created_at` and then `id` decide the order —
    // the tie the register's total order exists for.
    await expenseService.recordExpense({ ...common, amount: 99_000, memo: "posted mid-read" });

    const second = await expenseService.listExpenses(biz.id, { limit: 2, cursor: first.nextCursor });
    expect(second.expenses.map((e) => e.memo)).toEqual(["row 3", "row 2"]);
    const third = await expenseService.listExpenses(biz.id, { limit: 2, cursor: second.nextCursor });
    expect(third.expenses.map((e) => e.memo)).toEqual(["row 1"]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    // The totals describe the whole set, not the window that was walked.
    expect(third.totalCount).toBe(6);
    expect(third.totalAmount).toBe(1000 + 2000 + 3000 + 4000 + 5000 + 99_000);
  });

  it("posts input VAT on the chart's own VAT account, as three lines", async () => {
    const expense = await expenseService.recordExpense({
      ...base(),
      paymentAccountId: acct.cash,
      amount: 1_100_000,
      vatAmount: 100_000,
      expenseDate: "2025-04-15",
      memo: "Rent with VAT",
    });
    expect(expense.netAmount).toBe(1_000_000);

    const lines = await expenseService.getExpenseJournalLines(biz.id, expense.journalEntryId!);
    expect(lines).toEqual([
      { accountCode: "5300", accountName: "Rent", debit: 1_000_000, credit: 0 },
      { accountCode: "1220", accountName: "Input VAT", debit: 100_000, credit: 0 },
      { accountCode: "1100", accountName: "Cash", debit: 0, credit: 1_100_000 },
    ]);

    // Invalid tax arithmetic is refused, including the gross-equals-VAT case the
    // database CHECK also refuses.
    for (const vatAmount of [1_100_000, 2_000_000, -1, 1.5]) {
      await expect(
        expenseService.recordExpense({ ...base(), paymentAccountId: acct.cash, amount: 1_100_000, vatAmount, expenseDate: "2025-04-15", memo: "bad VAT" }),
      ).rejects.toThrow("vat_amount_invalid");
    }
  });

  it("refuses VAT when the chart has no input-VAT account to post it to", async () => {
    const noVatChart = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('No VAT Co', $1) RETURNING id",
      [`no-vat-${randomUUID().slice(0, 8)}`],
    );
    const { rows: [accounts] } = await db.query<{ rent: string; cash: string }>(
      `WITH a AS (
         INSERT INTO accounts (business_id, code, name, type)
         VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5300', 'Rent', 'expense')
         RETURNING id, code
       )
       SELECT (SELECT id FROM a WHERE code = '5300') AS rent, (SELECT id FROM a WHERE code = '1100') AS cash`,
      [noVatChart.rows[0].id],
    );
    await expect(
      expenseService.recordExpense({
        businessId: noVatChart.rows[0].id,
        locationId: null,
        accountId: accounts.rent,
        paymentAccountId: accounts.cash,
        amount: 1_100_000,
        vatAmount: 100_000,
        expenseDate: "2025-04-15",
        memo: "VAT without a VAT account",
        createdBy: null,
      }),
    ).rejects.toThrow("vat_account_missing");
  });

  it("links a party without depending on it, keeping the typed vendor", async () => {
    const party = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, is_active) VALUES ($1, 'Landlord Co', true) RETURNING id`,
      [biz.id],
    );
    const expense = await expenseService.recordExpense({
      ...base(),
      paymentAccountId: acct.cash,
      amount: 100_000,
      expenseDate: "2025-04-15",
      vendor: "The landlord, as typed",
      partyId: party.rows[0].id,
      memo: "Rent",
    });
    expect(expense.partyId).toBe(party.rows[0].id);
    expect(expense.partyName).toBe("Landlord Co");
    expect(expense.vendor).toBe("The landlord, as typed");

    // A rename must not rewrite history: the free text is the snapshot the
    // accountant recorded, and it survives whatever the directory does next.
    await db.query("UPDATE parties SET name = 'Landlord Holdings (was Landlord Co)' WHERE id = $1", [party.rows[0].id]);
    const afterRename = await expenseService.getExpense(biz.id, expense.id);
    expect(afterRename?.vendor).toBe("The landlord, as typed");
    expect(afterRename?.partyName).toBe("Landlord Holdings (was Landlord Co)");

    // Deleting the party clears the link and keeps the financial record intact —
    // the accounting-history rule 0211's `ON DELETE SET NULL` encodes.
    await db.query("DELETE FROM parties WHERE id = $1", [party.rows[0].id]);
    const afterDelete = await db.query<{ party_id: string | null; vendor: string; amount: string }>(
      "SELECT party_id, vendor, amount::text FROM expenses WHERE id = $1",
      [expense.id],
    );
    expect(afterDelete.rows[0]).toMatchObject({ party_id: null, vendor: "The landlord, as typed", amount: "100000" });

    // A party from another business is a refusal, not a silent unlink.
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Party Co', $1) RETURNING id",
      [`other-party-${randomUUID().slice(0, 8)}`],
    );
    const foreignParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, is_active) VALUES ($1, 'Their supplier', true) RETURNING id`,
      [otherBiz.rows[0].id],
    );
    await expect(
      expenseService.recordExpense({
        ...base(),
        paymentAccountId: acct.cash,
        amount: 10_000,
        expenseDate: "2025-04-15",
        partyId: foreignParty.rows[0].id,
        memo: "not ours",
      }),
    ).rejects.toThrow("party_not_found");
  });

  it("numbers each business's own documents, in its Jalali year, without gaps", async () => {
    const first = await expenseService.recordExpense({ ...base(), paymentAccountId: acct.cash, amount: 1000, expenseDate: "2025-04-15", memo: "one" });
    const second = await expenseService.recordExpense({ ...base(), paymentAccountId: acct.cash, amount: 2000, expenseDate: "2025-04-16", memo: "two" });
    expect(first.reference).toMatch(/^EXP-\d{4}-00001$/);
    // The Jalali year comes from the *business date*, so 2025-04-15 (1404) and
    // today (1405) number independently and neither overwrites the other.
    expect(second.reference).toMatch(/^EXP-\d{4}-\d{5}$/);
    expect(second.reference).not.toBe(first.reference);

    // Another business starts at its own 1: the counter is per tenant, and the
    // unique index is per tenant, so nobody else's numbering is ever a conflict.
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Counter Co', $1) RETURNING id",
      [`counter-${randomUUID().slice(0, 8)}`],
    );
    const { rows: [otherAccounts] } = await db.query<{ rent: string; cash: string }>(
      `WITH a AS (
         INSERT INTO accounts (business_id, code, name, type)
         VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5300', 'Rent', 'expense')
         RETURNING id, code
       )
       SELECT (SELECT id FROM a WHERE code = '5300') AS rent, (SELECT id FROM a WHERE code = '1100') AS cash`,
      [otherBiz.rows[0].id],
    );
    const theirs = await expenseService.recordExpense({
      businessId: otherBiz.rows[0].id,
      locationId: null,
      accountId: otherAccounts.rent,
      paymentAccountId: otherAccounts.cash,
      amount: 500,
      expenseDate: "2025-04-15",
      memo: "theirs",
      createdBy: null,
    });
    expect(theirs.reference).toMatch(/^EXP-\d{4}-00001$/);
    // Neither business can read the other's rows at all.
    expect(await expenseService.getExpense(biz.id, theirs.id)).toBeNull();
    expect(await expenseService.getExpense(otherBiz.rows[0].id, first.id)).toBeNull();
  });

  it("exposes the tenant's expense accounts as the AI's only vocabulary, with no fallback list", async () => {
    const accounts = await expenseService.listExpenseCategoryAccounts(biz.id);
    expect(accounts.map((a) => a.code)).toEqual(["5300"]);
    // An asset, a VAT account and a revenue account are *not* expense
    // categories, and neither is another business's chart.
    expect(accounts.some((a) => a.code === "1100")).toBe(false);
    expect(accounts.some((a) => a.code === "1220")).toBe(false);

    const empty = await expenseService.listExpenseCategoryAccounts(randomUUID());
    expect(empty).toEqual([]);
  });
});

/**
 * §18, asserted where it can be: there is no recurring-expense machinery to
 * schedule, so documentation claiming it is the defect, and the register must
 * not grow one by accident. `expenses` has no cadence column and the schema has
 * no template table — the two things a recurring implementation would need.
 */
describe("recurring expenses remain unimplemented (issue #832 §18)", () => {
  it("has no recurring-expense schema to claim", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'expenses' AND column_name ~ 'recur|cadence|template|schedule'`,
    );
    expect(rows).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name ~ 'recur'`,
    );
    expect(tables.rows).toEqual([]);
  });
});
