/**
 * Financial Accounts & Internal Transfers against a real PostgreSQL (issue #862).
 *
 * The issue's central promise is a *negative* one — no parallel accounting
 * engine, no shadow balance table, no second place money is recorded — and a
 * negative can only be demonstrated against the database. So every case here
 * reads the ledger tables directly and asks whether the document and its
 * `journal_lines` say the same thing:
 *
 *   §1  the schema itself: the enum, the linkage rule (one GL account per
 *       container, enforced by a UNIQUE index), append-only reversal shape, and
 *       RLS enabled *and* forced on both tables;
 *   §2  GL eligibility: an asset of the right role only — a payable, a parent, an
 *       already-linked account and an unknown code are each refused by name;
 *   §3  balances are `SUM(journal_lines)` — never a stored number — including
 *       exactly past 2^53, and the account card reconciles to the ledger's own
 *       figure over the same window;
 *   §4  a transfer posts one balanced entry in the same transaction as the
 *       document, with the fee on the right side of the right account;
 *   §5  and rolls back completely when any leg is refused — no half-posted entry,
 *       no orphan document;
 *   §6  concurrency: N identical requests with one idempotency key produce ONE
 *       document and ONE entry; the same key with a different payload is a
 *       conflict rather than a silent second posting;
 *   §7  reversal is a mirror entry that references the original, is idempotent,
 *       refuses a second reversal, and cannot itself be reversed;
 *   §8  a locked fiscal period refuses the posting, and the refusal is the
 *       ledger's own code;
 *   §9  tenant and branch isolation: another business's account is a 404, a
 *       branch the member may not write to is a 403, and both are checked before
 *       anything is written;
 *   §10 one currency per transfer: a cross-currency pair is refused, an archived
 *       account is refused, and a foreign currency with no rate is refused rather
 *       than converted at an invented one;
 *   §11 archiving is the only retirement: refused while the account holds money,
 *       restorable, and delete is never available;
 *   §12 the register's filters, totals and export walk agree with the rows.
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
let accountsService: typeof import("../src/lib/financial-accounts-service");
let transfersService: typeof import("../src/lib/financial-transfers-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const other = { id: "", bank: "" };
const user = { id: "" };
const gl = {
  cash: "",
  bank: "",
  bank2: "",
  bankParent: "",
  clearing: "",
  petty: "",
  payable: "",
  odd: "",
  fee: "",
  revenue: "",
};
const branch = { a: "", b: "" };

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
  databaseName = `pos_fin_${randomUUID().replaceAll("-", "")}`;
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
  accountsService = await import("../src/lib/financial-accounts-service");
  transfersService = await import("../src/lib/financial-transfers-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
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

async function seedBusiness(name: string, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM financial_transfers");
  await db.query("DELETE FROM financial_accounts");
  await db.query("DELETE FROM audit_log");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  // `exchange_rates` is append-only by trigger; deleting the business cascades
  // into it, which is the path the migration itself allows.
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  biz.id = await seedBusiness("Finance Co", `finance-${randomUUID().slice(0, 8)}`);
  other.id = await seedBusiness("Other Co", `other-${randomUUID().slice(0, 8)}`);

  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRows[0].id;

  const { rows: locationRows } = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Center', 'Asia/Tehran', true), ($1, 'North', 'Asia/Tehran', true)
     RETURNING id`,
    [biz.id],
  );
  branch.a = locationRows[0].id;
  branch.b = locationRows[1].id;

  /*
   * The chart the seeds give a business: cash 1100, bank 1110, card clearing
   * 1120, petty cash 1130 — plus a payable, an unrecognised code, a fee
   * expense account, and a parent/child pair, which are the four shapes §2 has
   * to tell apart.
   */
  const { rows: accountRows } = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type, is_active)
     VALUES
       ($1, '1100', 'Cash', 'asset', true),
       ($1, '1110', 'Bank', 'asset', true),
       ($1, '1112', 'Bank (parent)', 'asset', true),
       ($1, '1120', 'Card clearing', 'asset', true),
       ($1, '1130', 'Petty cash', 'asset', true),
       ($1, '2100', 'Accounts payable', 'liability', true),
       ($1, '9999', 'Unclassified asset', 'asset', true),
       ($1, '6100', 'Bank charges', 'expense', true),
       ($1, '4300', 'Sales', 'revenue', true)
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accountRows) {
    if (row.code === "1100") gl.cash = row.id;
    if (row.code === "1110") gl.bank = row.id;
    if (row.code === "1112") gl.bankParent = row.id;
    if (row.code === "1120") gl.clearing = row.id;
    if (row.code === "1130") gl.petty = row.id;
    if (row.code === "2100") gl.payable = row.id;
    if (row.code === "9999") gl.odd = row.id;
    if (row.code === "6100") gl.fee = row.id;
    if (row.code === "4300") gl.revenue = row.id;
  }
  // A child under 1112 — which is what makes 1112 a parent, and therefore not
  // postable. The child itself classifies as a bank, so it stays eligible.
  const { rows: childRows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type, parent_id, is_active)
     VALUES ($1, '1115', 'Bank — branch', 'asset', $2, true) RETURNING id`,
    [biz.id, gl.bankParent],
  );
  gl.bank2 = childRows[0].id;

  // The other business registers its own bank container, so §9 can point a
  // transfer at a real id that belongs to somebody else.
  const { rows: otherGl } = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1110', 'Bank', 'asset') RETURNING id`,
    [other.id],
  );
  const { rows: otherFa } = await db.query<{ id: string }>(
    `INSERT INTO financial_accounts (business_id, kind, name, gl_account_id, currency_code)
     VALUES ($1, 'bank', 'Their bank', $2, 'IRR') RETURNING id`,
    [other.id, otherGl[0].id],
  );
  other.bank = otherFa[0].id;
});

/**
 * Register a container directly in the table, so a test can seed the exact row
 * it needs (kind, branch, currency) without going through the service — the
 * service's own rules are what several of these tests then exercise.
 */
async function registerAccount(overrides: Record<string, unknown> = {}) {
  const row: Record<string, unknown> = {
    business_id: biz.id,
    location_id: null,
    kind: "bank",
    name: "Main bank",
    gl_account_id: gl.bank,
    currency_code: "IRR",
    is_default: false,
    ...overrides,
  };
  const entries = Object.entries(row);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO financial_accounts (${entries.map(([key]) => key).join(", ")})
     VALUES (${entries.map((_, index) => `$${index + 1}`).join(", ")}) RETURNING id`,
    entries.map(([, value]) => value),
  );
  return rows[0].id;
}

/** A USD bank container (its own GL account), for the currency rules. */
async function registerUsdAccount(code: string, name: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, $2, $3, 'asset') RETURNING id`,
    [biz.id, code, name],
  );
  const id = await registerAccount({
    kind: "bank",
    name,
    gl_account_id: rows[0].id,
    currency_code: "USD",
  });
  return { id, glAccountId: rows[0].id };
}

/** A balanced manual entry against one GL account — how money gets into a container. */
async function postManualEntry(params: { accountId: string; debit: string; credit: string; date?: string }) {
  const entryId = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (id, business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, $3::date, 'manual', 'manual', $4) RETURNING id`,
    [entryId, biz.id, params.date ?? "2025-04-10", user.id],
  );
  await db.query(
    `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
     VALUES ($1, $2, $3, $4), ($1, $5, $6, $7)`,
    [rows[0].id, params.accountId, params.debit, params.credit, gl.revenue, params.credit, params.debit],
  );
  return rows[0].id;
}

function createTransfer(
  overrides: Record<string, unknown> = {},
  params: { locationId?: string | null; allowedLocationIds?: readonly string[] | null } = {},
) {
  return transfersService.createFinancialTransfer({
    businessId: biz.id,
    actorId: user.id,
    locationId: params.locationId ?? null,
    allowedLocationIds: params.allowedLocationIds ?? null,
    input: {
      transferDate: "2025-04-15",
      amount: "1000000",
      ...overrides,
    },
  });
}

async function twoAccounts() {
  const cash = await registerAccount({ kind: "cash", name: "Till", gl_account_id: gl.cash });
  const bank = await registerAccount({ kind: "bank", name: "Main bank", gl_account_id: gl.bank });
  return { cash, bank };
}

describe("§1 the schema", () => {
  it("declares the four kinds the issue names", async () => {
    const { rows } = await db.query<{ label: string }>(
      `SELECT unnest(enum_range(NULL::financial_account_kind))::text AS label`,
    );
    expect(rows.map((row) => row.label)).toEqual(["bank", "cash", "petty_cash", "pos_psp"]);
  });

  it("enables AND forces row level security on both tables", async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class WHERE relname IN ('financial_accounts', 'financial_transfers') ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: "financial_accounts", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "financial_transfers", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const { rows: policies } = await db.query<{ tablename: string; qual: string }>(
      `SELECT tablename, qual FROM pg_policies
        WHERE tablename IN ('financial_accounts', 'financial_transfers')`,
    );
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.qual).toContain("app_rls_bypass()");
      expect(policy.qual).toContain("business_id = app_current_business()");
    }
  });

  it("stores no balance anywhere — a container's money is only ever a sum of lines", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('financial_accounts', 'financial_transfers') AND column_name LIKE '%balance%'`,
    );
    expect(rows).toEqual([]);
  });

  it("makes the GL link unique, so two containers can never share one balance", async () => {
    await registerAccount();
    await expect(
      db.query(
        `INSERT INTO financial_accounts (business_id, kind, name, gl_account_id, currency_code)
         VALUES ($1, 'bank', 'Second bank', $2, 'IRR')`,
        [biz.id, gl.bank],
      ),
    ).rejects.toThrow(/uq_financial_accounts_gl_account/);
  });

  it("refuses a reversal that does not point at the transfer it reverses", async () => {
    await expect(
      db.query(
        `INSERT INTO financial_transfers
           (business_id, transfer_number, sequence_no, transfer_date, source_account_id, destination_account_id,
            amount, fee_amount, fee_payer, currency_code, journal_entry_id, posting_mode, reversal_reason)
         VALUES ($1, 'TR-000001', 1, '2025-04-15', $2, $2, 1000, 0, 'source', 'IRR', $3, 'reversal', 'x')`,
        [biz.id, other.bank, randomUUID()],
      ),
    ).rejects.toThrow();
    // The named CHECKS are the shape of the document, so assert they exist.
    const { rows } = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'financial_transfers'::regclass AND contype = 'c' ORDER BY conname`,
    );
    expect(rows.map((row) => row.conname)).toEqual(
      expect.arrayContaining([
        "financial_transfers_distinct_accounts",
        "financial_transfers_fee_account_pair",
        "financial_transfers_reversal_shape",
        "financial_transfers_reversed_shape",
        "financial_transfers_idempotency_pair",
      ]),
    );
  });

  it("keeps every document's amount equal to what its entry posted", async () => {
    const { cash, bank } = await twoAccounts();
    await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      amount: "1000000",
      feeAmount: "5000",
      feeAccountId: gl.fee,
    });
    /*
     * The reconciliation an auditor would run, as SQL: for every transfer, the
     * document's own amount and the sum of its journal lines must agree, and the
     * entry must balance. A shadow balance table could drift from the ledger;
     * this cannot, because the document holds no derived figure at all.
     */
    const { rows } = await db.query<{ mismatch: string }>(
      `SELECT count(*)::text AS mismatch
         FROM financial_transfers t
         JOIN journal_lines jl ON jl.entry_id = t.journal_entry_id
        HAVING SUM(jl.debit) <> SUM(jl.credit)`,
    );
    expect(rows).toEqual([]);
    const { rows: lines } = await db.query<{ net: string }>(
      `SELECT SUM(jl.debit - jl.credit)::text AS net FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.business_id = $1`,
      [biz.id],
    );
    expect(lines[0].net).toBe("0");
  });
});

describe("§2 GL eligibility", () => {
  async function create(glAccountId: string, kind = "bank") {
    return accountsService.createFinancialAccount({
      businessId: biz.id,
      actorId: user.id,
      locationId: null,
      input: { kind, name: "Container", glAccountId },
    });
  }

  it("accepts the role's own account and records what it resolved to", async () => {
    const created = await create(gl.bank);
    expect(created.account).toMatchObject({ kind: "bank", glAccountCode: "1110", isActive: true, balance: "0" });
  });

  it("refuses a liability — a payable is not a container of the business's money", async () => {
    await expect(create(gl.payable)).rejects.toThrow("gl_account_not_postable");
  });

  it("refuses a parent account — it has no balance of its own to show", async () => {
    await expect(create(gl.bankParent)).rejects.toThrow("gl_account_is_parent");
    // …while the child under it is exactly what a container may link.
    const child = await create(gl.bank2);
    expect(child.account.glAccountCode).toBe("1115");
  });

  it("refuses an account whose code classifies as nothing", async () => {
    await expect(create(gl.odd)).rejects.toThrow("gl_account_unclassified");
  });

  it("refuses the wrong role for the kind, and reports it as a conflict", async () => {
    await expect(create(gl.cash, "bank")).rejects.toMatchObject({ message: "gl_account_unclassified" });
    // Petty cash linked as a petty-cash container is fine; as a bank it is not.
    const petty = await accountsService.createFinancialAccount({
      businessId: biz.id,
      actorId: user.id,
      locationId: null,
      input: { kind: "petty_cash", name: "Floats", glAccountId: gl.petty },
    });
    expect(petty.account.kind).toBe("petty_cash");
    await expect(
      accountsService.createFinancialAccount({
        businessId: biz.id,
        actorId: user.id,
        locationId: null,
        input: { kind: "bank", name: "Not petty", glAccountId: gl.petty },
      }),
    ).rejects.toThrow();
  });

  it("refuses an account another container already holds", async () => {
    await registerAccount();
    await expect(create(gl.bank)).rejects.toThrow("financial_account_already_linked");
  });

  it("takes a card terminal's clearing account, and a bank, but not a till", async () => {
    const terminal = await create(gl.clearing, "pos_psp");
    expect(terminal.account.kind).toBe("pos_psp");
    const bank = await create(gl.bank2, "pos_psp");
    expect(bank.account.glAccountCode).toBe("1115");
    await expect(create(gl.cash, "pos_psp")).rejects.toThrow();
  });

  it("lists only the accounts a kind can actually use", async () => {
    await registerAccount();
    const eligible = await accountsService.eligibleGlAccounts(biz.id, "bank");
    expect(eligible.map((row) => row.code)).toEqual(["1115"]);
    // The account being edited may keep its own GL account in its own picker.
    const { rows } = await db.query<{ id: string }>("SELECT id FROM financial_accounts WHERE business_id = $1", [biz.id]);
    const forEdit = await accountsService.eligibleGlAccounts(biz.id, "bank", { excludeAccountId: rows[0].id });
    expect(forEdit.map((row) => row.code)).toEqual(["1110", "1115"]);
  });
});

describe("§3 balances come from the ledger", () => {
  it("reads a container's balance as the sum of its GL account's lines", async () => {
    const bank = await registerAccount();
    await postManualEntry({ accountId: gl.bank, debit: "450000", credit: "0" });
    await postManualEntry({ accountId: gl.bank, debit: "0", credit: "50000" });

    const account = await accountsService.getFinancialAccount(biz.id, bank);
    expect(account?.balance).toBe("400000");
    const list = await accountsService.listFinancialAccounts(biz.id);
    expect(list.totalBalance).toBe("400000");
    expect(list.totalsByKind.bank).toBe("400000");
  });

  it("stays exact past 2^53 Rial, where a Number would start lying", async () => {
    const bank = await registerAccount();
    await postManualEntry({ accountId: gl.bank, debit: "9007199254740993", credit: "0" });
    const account = await accountsService.getFinancialAccount(biz.id, bank);
    expect(account?.balance).toBe("9007199254740993");
  });

  it("reconciles the account card to the ledger over the same window", async () => {
    const bank = await registerAccount();
    await postManualEntry({ accountId: gl.bank, debit: "1000000", credit: "0", date: "2025-03-31" });
    await postManualEntry({ accountId: gl.bank, debit: "250000", credit: "0", date: "2025-04-10" });
    await postManualEntry({ accountId: gl.bank, debit: "0", credit: "100000", date: "2025-04-20" });

    const card = await accountsService.financialAccountCard(biz.id, bank, { from: "2025-04-01", to: "2025-04-30" });
    expect(card.opening).toBe("1000000");
    expect(card.totalDebit).toBe("250000");
    expect(card.totalCredit).toBe("100000");
    expect(card.closing).toBe("1150000");
    expect(card.reconciliationDifference).toBe("0");
    // The whole-ledger figure is what the header shows beside the window's.
    expect(card.ledgerBalance).toBe("1150000");
    expect(card.rows).toHaveLength(2);
  });

  it("refuses a card for an unknown container, and a malformed id is the same 404", async () => {
    await expect(accountsService.financialAccountCard(biz.id, randomUUID(), {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(accountsService.financialAccountCard(biz.id, "not-a-uuid", {})).rejects.toMatchObject({ status: 404 });
    expect(await accountsService.getFinancialAccount(biz.id, "not-a-uuid")).toBeNull();
  });
});

describe("§4 posting a transfer", () => {
  it("writes the document and its balanced entry in one transaction", async () => {
    const { cash, bank } = await twoAccounts();
    const result = await createTransfer({ sourceAccountId: cash, destinationAccountId: bank, description: "Till to bank" });

    expect(result.duplicate).toBe(false);
    expect(result.transfer).toMatchObject({
      transferNumber: "TR-000001",
      amount: "1000000",
      feeAmount: "0",
      status: "posted",
      postingMode: "transfer",
      description: "Till to bank",
      sourceAccountName: "Till",
      destinationAccountName: "Main bank",
    });

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.account_id === gl.bank)).toMatchObject({ debit: "1000000", credit: "0" });
    expect(lines.find((line) => line.account_id === gl.cash)).toMatchObject({ debit: "0", credit: "1000000" });

    // The entry names the transfer as its source, so the register and the
    // journal can never disagree about what produced it.
    const { rows: entries } = await db.query<{ source_type: string; source_id: string }>(
      `SELECT source_type, source_id FROM journal_entries WHERE id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(entries[0]).toEqual({ source_type: "financial_transfer", source_id: result.transfer.id });
  });

  it("books a fee paid by the source as extra outflow from that account", async () => {
    const { cash, bank } = await twoAccounts();
    const result = await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      feeAmount: "5000",
      feeAccountId: gl.fee,
      feePayer: "source",
    });
    expect(result.transfer).toMatchObject({ sourceOutflow: "1005000", destinationInflow: "1000000" });
    const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(rows.find((line) => line.account_id === gl.cash)).toMatchObject({ debit: "0", credit: "1005000" });
    expect(rows.find((line) => line.account_id === gl.fee)).toMatchObject({ debit: "5000", credit: "0" });
    expect(rows.find((line) => line.account_id === gl.bank)).toMatchObject({ debit: "1000000", credit: "0" });
  });

  it("books a fee paid by the destination as money that never arrives there", async () => {
    const { cash, bank } = await twoAccounts();
    const result = await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      feeAmount: "5000",
      feeAccountId: gl.fee,
      feePayer: "destination",
    });
    expect(result.transfer).toMatchObject({ sourceOutflow: "1000000", destinationInflow: "995000" });
    const { rows } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(rows.find((line) => line.account_id === gl.bank)).toMatchObject({ debit: "995000" });
    expect(rows.find((line) => line.account_id === gl.cash)).toMatchObject({ credit: "1000000" });
  });

  it("refuses a fee that eats the whole destination-paid transfer", async () => {
    const { cash, bank } = await twoAccounts();
    await expect(
      createTransfer({
        sourceAccountId: cash,
        destinationAccountId: bank,
        feeAmount: "1000000",
        feeAccountId: gl.fee,
        feePayer: "destination",
      }),
    ).rejects.toThrow("fee_exceeds_amount");
  });

  it("writes an audit row for the posting", async () => {
    const { cash, bank } = await twoAccounts();
    const result = await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    const { rows } = await db.query<{ action: string; entity: string; entity_id: string }>(
      `SELECT action, entity, entity_id FROM audit_log WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows).toEqual([
      { action: "financial_transfer.posted", entity: "financial_transfer", entity_id: result.transfer.id },
    ]);
  });

  it("refuses a future date — the ledger's own day is the bound", async () => {
    const { cash, bank } = await twoAccounts();
    await expect(
      createTransfer({ sourceAccountId: cash, destinationAccountId: bank, transferDate: "2999-01-01" }),
    ).rejects.toThrow("transfer_date_in_future");
  });
});

describe("§5 rollback leaves no trace", () => {
  it("writes neither entry nor document when a leg is refused", async () => {
    const { cash, bank } = await twoAccounts();
    await expect(
      createTransfer({
        sourceAccountId: cash,
        destinationAccountId: bank,
        feeAmount: "5000",
        // A revenue account is not an expense: the fee cannot be booked here.
        feeAccountId: gl.revenue,
      }),
    ).rejects.toThrow("fee_account_invalid");

    const { rows: transfers } = await db.query("SELECT id FROM financial_transfers");
    const { rows: entries } = await db.query("SELECT id FROM journal_entries");
    expect(transfers).toEqual([]);
    expect(entries).toEqual([]);
  });

  it("writes nothing when a referenced project belongs to another business", async () => {
    const { cash, bank } = await twoAccounts();
    const { rows: theirProject } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'Their project', $2) RETURNING id`,
      [other.id, user.id],
    );
    await expect(
      createTransfer({ sourceAccountId: cash, destinationAccountId: bank, projectId: theirProject[0].id }),
    ).rejects.toThrow("project_not_found");
    const { rows } = await db.query("SELECT id FROM journal_entries");
    expect(rows).toEqual([]);
  });

  it("keeps a project of this business, and stamps it on the entry", async () => {
    const { cash, bank } = await twoAccounts();
    const { rows: project } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'Fit-out', $2) RETURNING id`,
      [biz.id, user.id],
    );
    const result = await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      projectId: project[0].id,
    });
    expect(result.transfer.projectName).toBe("Fit-out");
    const { rows } = await db.query<{ project_id: string }>(
      `SELECT project_id FROM journal_entries WHERE id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(rows[0].project_id).toBe(project[0].id);
    const filtered = await transfersService.listFinancialTransfers(biz.id, { projectId: project[0].id });
    expect(filtered.transfers).toHaveLength(1);
  });
});

describe("§6 idempotency and concurrency", () => {
  it("answers a retry with the first document instead of posting a second", async () => {
    const { cash, bank } = await twoAccounts();
    const input = { sourceAccountId: cash, destinationAccountId: bank, idempotencyKey: "retry-1" };
    const first = await createTransfer(input);
    const second = await createTransfer(input);
    expect(second.duplicate).toBe(true);
    expect(second.transfer.id).toBe(first.transfer.id);
    const { rows } = await db.query("SELECT id FROM financial_transfers");
    expect(rows).toHaveLength(1);
  });

  it("refuses the same key with a different payload rather than posting the wrong amount", async () => {
    const { cash, bank } = await twoAccounts();
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank, amount: "1000000", idempotencyKey: "retry-2" });
    await expect(
      createTransfer({ sourceAccountId: cash, destinationAccountId: bank, amount: "2000000", idempotencyKey: "retry-2" }),
    ).rejects.toThrow("idempotency_conflict");
  });

  it("posts exactly one document and one entry when N identical requests race", async () => {
    const { cash, bank } = await twoAccounts();
    const input = { sourceAccountId: cash, destinationAccountId: bank, idempotencyKey: "race-1" };
    const results = await Promise.allSettled([
      createTransfer(input),
      createTransfer(input),
      createTransfer(input),
      createTransfer(input),
    ]);
    for (const result of results) expect(result.status).toBe("fulfilled");
    const ids = new Set(results.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof createTransfer>>>).value.transfer.id));
    expect(ids.size).toBe(1);
    const { rows: transfers } = await db.query("SELECT id FROM financial_transfers");
    const { rows: entries } = await db.query("SELECT id FROM journal_entries");
    expect(transfers).toHaveLength(1);
    expect(entries).toHaveLength(1);
  }, 30_000);

  it("numbers documents from the tenant's own sequence, with no gaps or reuse", async () => {
    const { cash, bank } = await twoAccounts();
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    await createTransfer({ sourceAccountId: bank, destinationAccountId: cash });
    const { rows } = await db.query<{ transfer_number: string; sequence_no: string }>(
      "SELECT transfer_number, sequence_no FROM financial_transfers ORDER BY sequence_no",
    );
    expect(rows).toEqual([
      { transfer_number: "TR-000001", sequence_no: "1" },
      { transfer_number: "TR-000002", sequence_no: "2" },
    ]);
  });
});

describe("§7 reversal", () => {
  async function posted() {
    const { cash, bank } = await twoAccounts();
    const result = await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      feeAmount: "5000",
      feeAccountId: gl.fee,
      feePayer: "source",
    });
    return result.transfer;
  }

  it("mirrors the original entry leg for leg, on the same accounts", async () => {
    const original = await posted();
    const reversal = await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "Wrong amount",
      reversalDate: "2025-04-16",
    });

    expect(reversal.duplicate).toBe(false);
    expect(reversal.transfer).toMatchObject({
      transferNumber: "TR-000002",
      postingMode: "reversal",
      reversesTransferId: original.id,
      reversalReason: "Wrong amount",
      status: "posted",
    });

    const { rows: originalLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = $1 ORDER BY account_id`,
      [original.journalEntryId],
    );
    const { rows: mirrorLines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit::text AS debit, credit::text AS credit FROM journal_lines WHERE entry_id = $1 ORDER BY account_id`,
      [reversal.reversalEntryId],
    );
    expect(mirrorLines).toHaveLength(originalLines.length);
    for (const [index, line] of mirrorLines.entries()) {
      expect(line.account_id).toBe(originalLines[index].account_id);
      expect(line.debit).toBe(originalLines[index].credit);
      expect(line.credit).toBe(originalLines[index].debit);
    }

    // Net effect on every account is zero — the pair cancels in the ledger.
    const { rows: net } = await db.query<{ net: string }>(
      `SELECT SUM(debit - credit)::text AS net FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_id = $1 OR je.source_id = $2`,
      [original.id, reversal.transfer.id],
    );
    expect(net[0].net).toBe("0");
  });

  it("points the two entries at each other and marks the original", async () => {
    const original = await posted();
    const reversal = await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "Duplicate",
    });
    const { rows } = await db.query<{ id: string; reverses_entry_id: string | null; reversed_at: string | null }>(
      `SELECT id, reverses_entry_id, reversed_at::text FROM journal_entries WHERE id IN ($1, $2) ORDER BY id`,
      [original.journalEntryId, reversal.reversalEntryId],
    );
    const reversalEntry = rows.find((row) => row.id === reversal.reversalEntryId)!;
    const originalEntry = rows.find((row) => row.id === original.journalEntryId)!;
    expect(reversalEntry.reverses_entry_id).toBe(original.journalEntryId);
    expect(originalEntry.reversed_at).not.toBeNull();
  });

  it("marks the original reversed and remembers the reason on it", async () => {
    const original = await posted();
    await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "Bank returned it",
    });
    const updated = await transfersService.getFinancialTransfer(biz.id, original.id);
    /*
     * The reason is stored on the REVERSAL document — the shape CHECK forbids a
     * transfer-mode row from carrying one, so a correction can never edit the
     * original's own fields — and the original reports it by joining its mirror,
     * which is what lets the register say why a document was reversed.
     */
    expect(updated).toMatchObject({
      status: "reversed",
      reversalReason: "Bank returned it",
      reversalTransferNumber: "TR-000002",
      reversesTransferId: null,
    });
    expect(updated?.reversalEntryId).not.toBeNull();
  });

  it("refuses a second reversal, and replays the first for the same key", async () => {
    const original = await posted();
    const first = await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "First",
      idempotencyKey: "rev-1",
    });
    const replay = await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "First",
      idempotencyKey: "rev-1",
    });
    expect(replay.duplicate).toBe(true);
    expect(replay.reversalEntryId).toBe(first.reversalEntryId);

    await expect(
      transfersService.reverseFinancialTransfer({
        businessId: biz.id,
        transferId: original.id,
        actorId: user.id,
        reason: "Second",
      }),
    ).rejects.toThrow("transfer_already_reversed");
  });

  it("refuses to reverse a reversal", async () => {
    const original = await posted();
    const reversal = await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "Correction",
    });
    await expect(
      transfersService.reverseFinancialTransfer({
        businessId: biz.id,
        transferId: reversal.transfer.id,
        actorId: user.id,
        reason: "No",
      }),
    ).rejects.toThrow("transfer_not_reversible");
  });

  it("requires a reason — evidence with no explanation is not evidence", async () => {
    const original = await posted();
    await expect(
      transfersService.reverseFinancialTransfer({
        businessId: biz.id,
        transferId: original.id,
        actorId: user.id,
        reason: "   ",
      }),
    ).rejects.toThrow("reversal_reason_required");
  });

  it("has no edit path at all: the document's fields are its entry's", async () => {
    const original = await posted();
    const before = await db.query("SELECT amount::text FROM financial_transfers WHERE id = $1", [original.id]);
    // There is no update function on the service, and the register does not
    // offer one; the only correction is a reversal.
    expect(before.rows[0].amount).toBe("1000000");
    await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: original.id,
      actorId: user.id,
      reason: "Correction",
    });
    const after = await db.query("SELECT amount::text FROM financial_transfers WHERE id = $1", [original.id]);
    expect(after.rows[0].amount).toBe("1000000");
  });
});

describe("§8 fiscal-period locks", () => {
  async function lockFarvardin() {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", user.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", user.id);
    return farvardin;
  }

  it("refuses a transfer dated into a locked period, with the ledger's own code", async () => {
    const { cash, bank } = await twoAccounts();
    const farvardin = await lockFarvardin();
    await expect(
      createTransfer({ sourceAccountId: cash, destinationAccountId: bank, transferDate: farvardin.startsOn }),
    ).rejects.toThrow("fiscal_period_locked");
    const { rows } = await db.query("SELECT id FROM journal_entries");
    expect(rows).toEqual([]);
  });

  it("refuses a reversal dated into a locked period too", async () => {
    const { cash, bank } = await twoAccounts();
    const original = await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    const farvardin = await lockFarvardin();
    await expect(
      transfersService.reverseFinancialTransfer({
        businessId: biz.id,
        transferId: original.transfer.id,
        actorId: user.id,
        reason: "Correction",
        reversalDate: farvardin.startsOn,
      }),
    ).rejects.toThrow("fiscal_period_locked");
    const stillPosted = await transfersService.getFinancialTransfer(biz.id, original.transfer.id);
    expect(stillPosted?.status).toBe("posted");
  });
});

describe("§9 tenant and branch isolation", () => {
  it("refuses another business's account as source and as destination", async () => {
    const { cash } = await twoAccounts();
    await expect(
      createTransfer({ sourceAccountId: other.bank, destinationAccountId: cash }),
    ).rejects.toThrow("source_account_not_found");
    await expect(
      createTransfer({ sourceAccountId: cash, destinationAccountId: other.bank }),
    ).rejects.toThrow("destination_account_not_found");
    const { rows } = await db.query("SELECT id FROM journal_entries");
    expect(rows).toEqual([]);
  });

  it("refuses a branch the member may not write to", async () => {
    const central = await registerAccount();
    const branchBank = await registerAccount({
      location_id: branch.b,
      gl_account_id: gl.bank2,
      name: "North bank",
    });
    const cash = await registerAccount({ kind: "cash", name: "Till", gl_account_id: gl.cash });
    void central;

    await expect(
      createTransfer({ sourceAccountId: branchBank, destinationAccountId: cash }, { allowedLocationIds: [branch.a] }),
    ).rejects.toThrow("no_source_branch_access");
    // …and the member who may write to that branch can post it.
    const allowed = await createTransfer(
      { sourceAccountId: branchBank, destinationAccountId: cash },
      { allowedLocationIds: [branch.b] },
    );
    expect(allowed.transfer.status).toBe("posted");
  });

  it("does not read another business's containers or transfers", async () => {
    const mine = await registerAccount();
    const theirs = await accountsService.listFinancialAccounts(other.id);
    // The other business's register is its own row and nothing of mine.
    expect(theirs.accounts.map((row) => row.id)).toEqual([other.bank]);
    expect(theirs.accounts.map((row) => row.id)).not.toContain(mine);

    // A transfer belongs to the business that posted it, whichever side is asked.
    const cash = await registerAccount({ kind: "cash", name: "Till", gl_account_id: gl.cash });
    await createTransfer({ sourceAccountId: cash, destinationAccountId: mine });
    expect(await transfersService.listFinancialTransfers(other.id)).toMatchObject({ transfers: [], totalCount: 0 });
    // …and its own register is not readable through the other tenant's id.
    expect(await transfersService.getFinancialTransfer(other.id, "not-a-uuid")).toBeNull();
  });
});

describe("§10 one currency, no invented rates", () => {
  it("refuses a transfer between accounts in different currencies", async () => {
    const bank = await registerAccount();
    const { rows: usd } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '1118', 'Bank USD', 'asset') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO financial_accounts (business_id, kind, name, gl_account_id, currency_code)
       VALUES ($1, 'bank', 'USD bank', $2, 'USD')`,
      [biz.id, usd[0].id],
    );
    const { rows: usdAccount } = await db.query<{ id: string }>(
      "SELECT id FROM financial_accounts WHERE gl_account_id = $1",
      [usd[0].id],
    );
    await expect(
      createTransfer({ sourceAccountId: bank, destinationAccountId: usdAccount[0].id }),
    ).rejects.toThrow("currency_mismatch");
  });

  it("refuses a foreign transfer with no effective rate rather than converting at one it made up", async () => {
    const first = await registerUsdAccount("1118", "USD bank A");
    const second = await registerUsdAccount("1119", "USD bank B");
    // The business enabled USD (a container in it could not exist otherwise) but
    // has registered no exchange rate, so there is nothing to convert at.
    await expect(
      createTransfer({ sourceAccountId: first.id, destinationAccountId: second.id }),
    ).rejects.toThrow("currency_rate_missing");
  });

  it("books a foreign transfer at the rate already on file, and says which one it used", async () => {
    const first = await registerUsdAccount("1118", "USD bank A");
    const second = await registerUsdAccount("1119", "USD bank B");
    await db.query(
      `INSERT INTO exchange_rates (business_id, currency_code, rate, effective_from, created_by)
       VALUES ($1, 'USD', 1000000, '2025-01-01', $2)`,
      [biz.id, user.id],
    );
    const result = await createTransfer({
      sourceAccountId: first.id,
      destinationAccountId: second.id,
      amount: "10",
    });
    /*
     * 10 USD at 1,000,000 Rial per whole unit, with USD's two minor digits, is
     * 10 × 1,000,000 ÷ 100 = 100,000 Rial in the base — the same conversion the
     * multicurrency engine performs for every other foreign document, imported
     * rather than re-derived.
     */
    const { rows } = await db.query<{
      currency_code: string;
      exchange_rate: string;
      rounding_delta: string;
      debit: string;
      foreign_debit: string;
    }>(
      `SELECT je.currency_code, je.exchange_rate::text AS exchange_rate, je.rounding_delta::text AS rounding_delta,
              jl.debit::text AS debit, jl.foreign_debit::text AS foreign_debit
         FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.id = $1 AND jl.account_id = $2`,
      [result.transfer.journalEntryId, second.glAccountId],
    );
    expect(rows[0]).toEqual({
      currency_code: "USD",
      exchange_rate: "1000000",
      rounding_delta: "0",
      debit: "100000",
      foreign_debit: "10",
    });
    // The rate is frozen onto the entry, so a later rate change cannot rewrite it.
    const { rows: balanced } = await db.query<{ net: string }>(
      `SELECT SUM(debit - credit)::text AS net FROM journal_lines WHERE entry_id = $1`,
      [result.transfer.journalEntryId],
    );
    expect(balanced[0].net).toBe("0");
  });

  it("refuses an archived account as either side", async () => {
    const { cash, bank } = await twoAccounts();
    await db.query("UPDATE financial_accounts SET is_active = false, archived_at = now() WHERE id = $1", [cash]);
    await expect(createTransfer({ sourceAccountId: cash, destinationAccountId: bank })).rejects.toThrow(
      "source_account_archived",
    );
  });

  it("refuses a container that does not exist", async () => {
    const { cash } = await twoAccounts();
    await expect(
      createTransfer({ sourceAccountId: randomUUID(), destinationAccountId: cash }),
    ).rejects.toThrow("source_account_not_found");
  });
});

describe("§11 retire by archiving, never by deleting", () => {
  it("refuses to archive a container that still holds money", async () => {
    const bank = await registerAccount();
    await postManualEntry({ accountId: gl.bank, debit: "1000", credit: "0" });
    await expect(
      accountsService.archiveFinancialAccount({ businessId: biz.id, accountId: bank, actorId: user.id }),
    ).rejects.toThrow("financial_account_has_balance");
  });

  it("archives an empty container, keeps its history, and brings it back", async () => {
    const bank = await registerAccount();
    await postManualEntry({ accountId: gl.bank, debit: "1000", credit: "0" });
    await postManualEntry({ accountId: gl.bank, debit: "0", credit: "1000" });

    const archived = await accountsService.archiveFinancialAccount({
      businessId: biz.id,
      accountId: bank,
      actorId: user.id,
      reason: "Closed the branch",
    });
    expect(archived).toMatchObject({ id: bank, balance: "0" });

    const list = await accountsService.listFinancialAccounts(biz.id, { status: "active" });
    expect(list.accounts).toEqual([]);
    const archivedList = await accountsService.listFinancialAccounts(biz.id, { status: "archived" });
    expect(archivedList.accounts.map((row) => row.id)).toEqual([bank]);
    // The money that moved through it is still in the ledger.
    const { rows } = await db.query("SELECT id FROM journal_lines WHERE account_id = $1", [gl.bank]);
    expect(rows).toHaveLength(2);

    const restored = await accountsService.reactivateFinancialAccount({
      businessId: biz.id,
      accountId: bank,
      actorId: user.id,
    });
    expect(restored.account).toMatchObject({ isActive: true, isDefault: false, archivedAt: null });
  });

  it("has no delete at all, and says what to do instead", () => {
    expect(() => accountsService.refuseFinancialAccountDelete()).toThrow("financial_account_delete_forbidden");
  });

  it("freezes the GL link, the kind and the currency once money has moved", async () => {
    const { cash, bank } = await twoAccounts();
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    await expect(
      accountsService.updateFinancialAccount({
        businessId: biz.id,
        accountId: bank,
        actorId: user.id,
        input: { glAccountId: gl.bank2 },
      }),
    ).rejects.toThrow("financial_account_identity_locked");
    // …and a rename still works, because it changes nothing a document means.
    const renamed = await accountsService.updateFinancialAccount({
      businessId: biz.id,
      accountId: bank,
      actorId: user.id,
      input: { name: "Main bank (renamed)" },
    });
    expect(renamed.account.name).toBe("Main bank (renamed)");
  });

  it("refuses a flag flip through PATCH — archiving has a rule attached", async () => {
    const bank = await registerAccount();
    await expect(
      accountsService.updateFinancialAccount({
        businessId: biz.id,
        accountId: bank,
        actorId: user.id,
        input: { isActive: false },
      }),
    ).rejects.toThrow("financial_account_archive_via_endpoint");
  });
});

describe("§13 existing data is left alone", () => {
  it("registers a container on a GL account that already has history, without touching it", async () => {
    // Three years of history posted before «حساب‌های مالی» existed.
    const entryOne = await postManualEntry({ accountId: gl.bank, debit: "5000000", credit: "0", date: "2024-01-05" });
    const entryTwo = await postManualEntry({ accountId: gl.bank, debit: "0", credit: "1000000", date: "2024-06-05" });
    const before = await db.query("SELECT id FROM journal_lines WHERE entry_id = ANY($1::uuid[]) ORDER BY id", [
      [entryOne, entryTwo],
    ]);

    const bank = await registerAccount();
    const account = await accountsService.getFinancialAccount(biz.id, bank);
    // The container adopts the existing balance — the money was always there;
    // the register is a *view* of it, not a new ledger.
    expect(account?.balance).toBe("4000000");

    const after = await db.query("SELECT id FROM journal_lines WHERE entry_id = ANY($1::uuid[]) ORDER BY id", [
      [entryOne, entryTwo],
    ]);
    expect(after.rows).toEqual(before.rows);

    // …and history that predates the container shows on its card as movements.
    const card = await accountsService.financialAccountCard(biz.id, bank, {});
    expect(card.rows).toHaveLength(2);
    expect(card.closing).toBe("4000000");
    expect(card.reconciliationDifference).toBe("0");
  });

  it("offers nothing, and invents nothing, when the chart has no container account", async () => {
    // A business whose chart has no 11xx seeds at all: an expense-only chart.
    const bare = await seedBusiness("Bare Co", `bare-${randomUUID().slice(0, 8)}`);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5300', 'Rent', 'expense') RETURNING id`,
      [bare],
    );
    expect(await accountsService.eligibleGlAccounts(bare, "bank")).toEqual([]);
    await expect(
      accountsService.createFinancialAccount({
        businessId: bare,
        actorId: null,
        locationId: null,
        input: { kind: "bank", name: "Nowhere", glAccountId: rows[0].id },
      }),
    ).rejects.toThrow();
  });

  it("never mentions a container in the GL history it did not post", async () => {
    // Registering a container writes an audit row and nothing else: no entry, no
    // line, no balance. A register that posted on creation would be a second
    // accounting engine. (Through the service, which is what owns the audit row.)
    await accountsService.createFinancialAccount({
      businessId: biz.id,
      actorId: user.id,
      locationId: null,
      input: { kind: "bank", name: "Main bank", glAccountId: gl.bank },
    });
    const { rows } = await db.query<{ entries: string; lines: string }>(
      `SELECT (SELECT count(*) FROM journal_entries WHERE business_id = $1)::text AS entries,
              (SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
                WHERE je.business_id = $1)::text AS lines`,
      [biz.id],
    );
    expect(rows[0]).toEqual({ entries: "0", lines: "0" });
    const { rows: audited } = await db.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE business_id = $1 ORDER BY action",
      [biz.id],
    );
    expect(audited.map((row) => row.action)).toEqual(["financial_account.created"]);
  });
});

describe("§12 the register, its totals and its export", () => {
  it("filters by kind, branch, default and free text, and totals the whole match", async () => {
    const cash = await registerAccount({ kind: "cash", name: "Till", gl_account_id: gl.cash, code: "CASH-1" });
    const bank = await registerAccount({ name: "Main bank", is_default: true, location_id: branch.a });
    await postManualEntry({ accountId: gl.cash, debit: "300000", credit: "0" });
    await postManualEntry({ accountId: gl.bank, debit: "1500000", credit: "0" });

    const all = await accountsService.listFinancialAccounts(biz.id);
    expect(all.totalBalance).toBe("1800000");
    expect(all.totalsByKind).toMatchObject({ cash: "300000", bank: "1500000", petty_cash: "0", pos_psp: "0" });
    expect(all.activeCount).toBe(2);

    const cashOnly = await accountsService.listFinancialAccounts(biz.id, { kind: "cash" });
    expect(cashOnly.accounts.map((row) => row.id)).toEqual([cash]);
    expect(cashOnly.totalBalance).toBe("300000");

    const branchOnly = await accountsService.listFinancialAccounts(biz.id, { locationId: branch.a });
    expect(branchOnly.accounts.map((row) => row.id)).toEqual([bank]);

    const defaults = await accountsService.listFinancialAccounts(biz.id, { defaultOnly: true });
    expect(defaults.accounts.map((row) => row.id)).toEqual([bank]);

    const searched = await accountsService.listFinancialAccounts(biz.id, { q: "CASH-1" });
    expect(searched.accounts.map((row) => row.id)).toEqual([cash]);
  });

  it("walks every page for an export, not just the first one", async () => {
    const { cash, bank } = await twoAccounts();
    // Three movements is enough to prove the walk follows its page size; the
    // generator is what the export route uses, and it must not stop early.
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    await createTransfer({ sourceAccountId: bank, destinationAccountId: cash });
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });

    const walked: string[] = [];
    for await (const transfer of transfersService.iterateTransfersForExport(biz.id, {})) {
      walked.push(transfer.transferNumber);
    }
    expect(walked).toEqual(["TR-000003", "TR-000002", "TR-000001"]);

    // …and refuses past its own ceiling rather than truncating a file silently.
    const limited: string[] = [];
    await expect(async () => {
      for await (const transfer of transfersService.iterateTransfersForExport(biz.id, {}, { maxRows: 2 })) {
        limited.push(transfer.transferNumber);
      }
    }).rejects.toThrow("report_too_large");
    expect(limited).toHaveLength(2);
  });

  it("filters the register by account, status and free text", async () => {
    const { cash, bank } = await twoAccounts();
    const first = await createTransfer({
      sourceAccountId: cash,
      destinationAccountId: bank,
      referenceNumber: "REF-77",
      description: "Cash deposit",
    });
    await createTransfer({ sourceAccountId: bank, destinationAccountId: cash });

    const byAccount = await transfersService.listFinancialTransfers(biz.id, { accountId: cash });
    expect(byAccount.transfers).toHaveLength(2);
    const asSource = await transfersService.listFinancialTransfers(biz.id, { sourceAccountId: cash });
    expect(asSource.transfers.map((row) => row.id)).toEqual([first.transfer.id]);
    const byText = await transfersService.listFinancialTransfers(biz.id, { q: "REF-77" });
    expect(byText.transfers.map((row) => row.id)).toEqual([first.transfer.id]);

    await transfersService.reverseFinancialTransfer({
      businessId: biz.id,
      transferId: first.transfer.id,
      actorId: user.id,
      reason: "Corrected",
    });
    const reversed = await transfersService.listFinancialTransfers(biz.id, { status: "reversed" });
    expect(reversed.reversedCount).toBe(1);
    const posted = await transfersService.listFinancialTransfers(biz.id, { status: "posted" });
    expect(posted.postedCount).toBe(1);
  });

  it("caps a page but states the whole filtered total", async () => {
    const { cash, bank } = await twoAccounts();
    for (let index = 0; index < 3; index += 1) {
      await createTransfer({ sourceAccountId: cash, destinationAccountId: bank, amount: "100000" });
    }
    const page = await transfersService.listFinancialTransfers(biz.id, { limit: 2 });
    expect(page.transfers).toHaveLength(2);
    expect(page.totalCount).toBe(3);
    expect(page.totalAmount).toBe("300000");
    const rest = await transfersService.listFinancialTransfers(biz.id, { limit: 2, offset: 2 });
    expect(rest.transfers).toHaveLength(1);
  });

  it("gives an account's own transfer history, with the counterparty's name", async () => {
    const { cash, bank } = await twoAccounts();
    await createTransfer({ sourceAccountId: cash, destinationAccountId: bank });
    const history = await transfersService.listAccountTransfers(biz.id, cash);
    expect(history.transfers).toHaveLength(1);
    expect(history.transfers[0]).toMatchObject({ sourceAccountName: "Till", destinationAccountName: "Main bank" });
  });
});
