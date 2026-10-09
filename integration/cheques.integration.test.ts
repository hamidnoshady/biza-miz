/**
 * Phase 30 — cheques (چک).
 *
 * Proves the two things a cheque subledger has to get right: every step of a
 * cheque's life posts the entry it owes (and only that entry), and the
 * contingency an endorsement creates resolves correctly in both directions —
 * the supplier's balance goes down when the cheque is handed over, and comes
 * back if it bounces.
 *
 * Also pins the two guards: an illegal transition is refused rather than posting
 * something incoherent, and RLS keeps one business's cheques out of another's.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";
import * as chequesPure from "../src/lib/cheques";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let cheques: typeof import("../src/lib/cheques-service");
let ar: typeof import("../src/lib/ar-service");
let ap: typeof import("../src/lib/ap-service");
let provisioning: typeof import("../src/lib/business-provisioning");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "", locationId: "" };
const other = { id: "" };
const party = { customerId: "", supplierId: "", otherSupplierId: "" };

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
  databaseName = `pos_cheques_${randomUUID().replaceAll("-", "")}`;

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
  cheques = await import("../src/lib/cheques-service");
  ar = await import("../src/lib/ar-service");
  ap = await import("../src/lib/ap-service");
  provisioning = await import("../src/lib/business-provisioning");
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

async function makeBusiness(slugPrefix: string): Promise<{ id: string; locationId: string }> {
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [`${slugPrefix} Co`, `${slugPrefix}-${randomUUID().slice(0, 8)}`],
  );
  const id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [id],
  );
  const client = await dbLib.getPool().connect();
  try {
    await provisioning.seedChartOfAccounts(client, id, "food_service");
  } finally {
    client.release();
  }
  return { id, locationId: locRow.rows[0].id };
}

beforeEach(async () => {
  await db.query("DELETE FROM cheque_events");
  await db.query("DELETE FROM cheques");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const made = await makeBusiness("cheque");
  biz.id = made.id;
  biz.locationId = made.locationId;
  other.id = (await makeBusiness("rival")).id;

  const customerRow = await db.query<{ id: string }>(
    "INSERT INTO parties (business_id, name) VALUES ($1, 'مشتری') RETURNING id",
    [biz.id],
  );
  party.customerId = customerRow.rows[0].id;

  const supplierRow = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده') RETURNING id",
    [biz.locationId],
  );
  party.supplierId = supplierRow.rows[0].id;

  const otherLoc = await db.query<{ id: string }>(
    "SELECT id FROM locations WHERE business_id = $1",
    [other.id],
  );
  const otherSupplier = await db.query<{ id: string }>(
    "INSERT INTO suppliers (location_id, name) VALUES ($1, 'تأمین‌کننده رقیب') RETURNING id",
    [otherLoc.rows[0].id],
  );
  party.otherSupplierId = otherSupplier.rows[0].id;
});

/** Every journal line posted for one cheque, as `code: debit-credit` pairs. */
async function linesFor(chequeId: string): Promise<Record<string, number>[]> {
  const { rows } = await db.query<{ code: string; debit: string; credit: string; entry_id: string }>(
    `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit, je.id AS entry_id
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
       JOIN accounts a ON a.id = jl.account_id
      WHERE je.source_type = 'cheque' AND je.source_id = $1
      ORDER BY je.posted_at, je.id, jl.id`,
    [chequeId],
  );
  return rows.map((r) => ({ [r.code]: Number(r.debit) - Number(r.credit) }));
}

/** The business-wide balance of one account code, debit-positive. */
async function balanceOf(code: string): Promise<number> {
  const { rows } = await db.query<{ balance: string }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      WHERE a.business_id = $1 AND a.code = $2`,
    [biz.id, code],
  );
  return Number(rows[0].balance);
}

/** How many cheques of this business carry that serial. */
async function countOf(serialNumber: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM cheques WHERE business_id = $1 AND serial_number = $2",
    [biz.id, serialNumber],
  );
  return Number(rows[0].count);
}

function receivable(overrides: Partial<Parameters<typeof cheques.recordCheque>[0]> = {}) {
  return cheques.recordCheque({
    businessId: biz.id,
    locationId: biz.locationId,
    direction: "receivable",
    serialNumber: `S${randomUUID().slice(0, 8)}`,
    bankName: "ملت",
    amount: 5_000_000,
    issueDate: "2026-01-10",
    dueDate: "2026-03-10",
    counterpartyName: "مشتری",
    customerId: party.customerId,
    createdBy: null,
    ...overrides,
  });
}

function payable(overrides: Partial<Parameters<typeof cheques.recordCheque>[0]> = {}) {
  return cheques.recordCheque({
    businessId: biz.id,
    locationId: biz.locationId,
    direction: "payable",
    serialNumber: `P${randomUUID().slice(0, 8)}`,
    bankName: "صادرات",
    amount: 3_000_000,
    issueDate: "2026-01-10",
    dueDate: "2026-02-20",
    counterpartyName: "تأمین‌کننده",
    supplierId: party.supplierId,
    createdBy: null,
    ...overrides,
  });
}

describe("recording a cheque", () => {
  it("puts a customer's cheque in چک‌های نزد صندوق against their account", async () => {
    const cheque = await receivable();
    expect(cheque.status).toBe("on_hand");
    expect(await linesFor(cheque.id)).toEqual([{ "1241": 5_000_000 }, { "1200": -5_000_000 }]);
  });

  it("clears down what we owe a supplier into چک‌های صادرشده", async () => {
    const cheque = await payable();
    expect(cheque.status).toBe("issued");
    expect(await linesFor(cheque.id)).toEqual([{ "2100": 3_000_000 }, { "2121": -3_000_000 }]);
  });

  it("normalises a صیاد id typed in Persian digits, and refuses a malformed one", async () => {
    const cheque = await receivable({ sayadId: "۱۲۳۴۵۶۷۸۹۰۱۲۳۴۵۶" });
    expect(cheque.sayadId).toBe("1234567890123456");
    await expect(receivable({ sayadId: "12345" })).rejects.toThrow("invalid_sayad_id");
  });

  it("refuses the same bank's same serial twice — one cheque is one row", async () => {
    await receivable({ serialNumber: "SAME-1" });
    await expect(receivable({ serialNumber: "SAME-1" })).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a counterparty that belongs to someone else", async () => {
    await expect(payable({ supplierId: party.otherSupplierId })).rejects.toThrow("supplier_not_found");
  });

  it("refuses an amount that isn't a positive whole Rial", async () => {
    await expect(receivable({ amount: 0 })).rejects.toThrow("invalid_amount");
    await expect(receivable({ amount: -1 })).rejects.toThrow("invalid_amount");
    await expect(receivable({ amount: 1.5 })).rejects.toThrow("invalid_amount");
  });

  it("rejects malformed and impossible cheque dates before Postgres sees them", async () => {
    await expect(receivable({ issueDate: "2026-02-29" })).rejects.toThrow("invalid_issue_date");
    await expect(receivable({ dueDate: "2026-02-31" })).rejects.toThrow("invalid_due_date");
    await expect(receivable({ issueDate: "2026-03-11", dueDate: "2026-03-10" })).rejects.toThrow(
      "due_date_before_issue",
    );
  });

  it("rejects a linked party from the other cheque direction", async () => {
    await expect(receivable({ supplierId: party.supplierId })).rejects.toThrow("invalid_counterparty_for_direction");
    await expect(payable({ customerId: party.customerId })).rejects.toThrow("invalid_counterparty_for_direction");
  });

  it("accepts a customer whose primary role is supplier but whose role set includes customer", async () => {
    await db.query(
      `UPDATE parties SET role = 'supplier', roles = ARRAY['customer', 'supplier']::text[] WHERE id = $1`,
      [party.customerId],
    );

    expect((await ar.listCustomerDirectory(biz.id)).map((customer) => customer.customerId)).toContain(party.customerId);
    await expect(receivable()).resolves.toMatchObject({ customerId: party.customerId });
  });
});

describe("cheque attribution in the party subledgers", () => {
  it("shows a received cheque against the selected customer in their A/R balance and statement", async () => {
    const cheque = await receivable();

    await expect(ar.getCustomerArBalance(biz.id, party.customerId)).resolves.toEqual({
      balance: -5_000_000,
      hasLedger: true,
    });
    const statement = await ar.getCustomerStatement(biz.id, party.customerId);
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({ credit: 5_000_000, debit: 0, type: "other" });
    expect(statement[0].description).toContain(cheque.serialNumber);
  });

  it("shows an issued cheque against its supplier in the A/P register", async () => {
    const cheque = await payable();

    expect(await ap.listSupplierBalances(biz.id)).toContainEqual({
      supplierId: party.supplierId,
      supplierName: "تأمین‌کننده",
      supplierPartyId: null,
      supplierPhone: null,
      locationId: biz.locationId,
      locationName: "Main",
      balance: -3_000_000,
    });
    const statement = await ap.getSupplierStatement(biz.id, party.supplierId);
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({ debit: 3_000_000, credit: 0, type: "cheque" });
    expect(statement[0].description).toContain(cheque.serialNumber);
  });

  it("keeps an endorsed cheque and its later bounce on the same supplier statement", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      occurredOn: "2026-02-10",
      createdBy: null,
    });

    expect(await ap.listSupplierBalances(biz.id)).toContainEqual({
      supplierId: party.supplierId,
      supplierName: "تأمین‌کننده",
      supplierPartyId: null,
      supplierPhone: null,
      locationId: biz.locationId,
      locationName: "Main",
      balance: -5_000_000,
    });

    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce",
      occurredOn: "2026-02-11",
      createdBy: null,
    });

    expect(await ap.listSupplierBalances(biz.id)).toEqual([]);
    const statement = await ap.getSupplierStatement(biz.id, party.supplierId);
    expect(statement.map((line) => [line.debit, line.credit])).toEqual([
      [5_000_000, 0],
      [0, 5_000_000],
    ]);
  });
});

describe("the ordinary life of a cheque we took", () => {
  it("banks it, then clears it into the bank account", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      createdBy: null,
    });
    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "clear",
      occurredOn: "2026-03-12",
      createdBy: null,
    });

    expect(cleared.status).toBe("cleared");
    expect(await linesFor(cheque.id)).toEqual([
      { "1241": 5_000_000 },
      { "1200": -5_000_000 },
      { "1242": 5_000_000 },
      { "1241": -5_000_000 },
      { "1110": 5_000_000 },
      { "1242": -5_000_000 },
    ]);
  });

  it("records every step in the cheque's own history, each pointing at its entry", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      createdBy: null,
    });
    const history = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(history.map((h) => h.event)).toEqual(["received", "deposited"]);
    expect(history.every((h) => h.entryId !== null)).toBe(true);
  });

  it("bounces from the bank back into چک‌های برگشتی", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      createdBy: null,
    });
    const bounced = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce",
      createdBy: null,
    });
    expect(bounced.status).toBe("bounced");
    expect((await linesFor(cheque.id)).slice(-2)).toEqual([{ "1244": 5_000_000 }, { "1242": -5_000_000 }]);
  });
});

describe("endorsement (ظهرنویسی)", () => {
  it("hands the cheque to a supplier and reduces what we owe them", async () => {
    const cheque = await receivable();
    const endorsed = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      createdBy: null,
    });

    expect(endorsed.status).toBe("endorsed");
    expect((await linesFor(cheque.id)).slice(-2)).toEqual([{ "2100": 5_000_000 }, { "1241": -5_000_000 }]);

    const history = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(history.at(-1)!.endorsedToSupplierId).toBe(party.supplierId);
  });

  it("posts nothing when an endorsed cheque clears — the debt already moved", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      createdBy: null,
    });
    const before = await linesFor(cheque.id);

    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "clear",
      createdBy: null,
    });

    expect(cleared.status).toBe("cleared");
    expect(await linesFor(cheque.id)).toEqual(before);
    // The step still happened, and the history says so with no entry behind it.
    const history = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(history.at(-1)).toMatchObject({ event: "cleared", entryId: null });
  });

  it("puts the debt back on us when an endorsed cheque bounces", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce",
      createdBy: null,
    });

    // Credit accounts payable: the supplier is owed again. And the whole trip
    // nets to چک‌های برگشتی holding it and AP back where it started.
    expect((await linesFor(cheque.id)).slice(-2)).toEqual([{ "1244": 5_000_000 }, { "2100": -5_000_000 }]);

    const { rows } = await db.query<{ balance: string }>(
      `SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE a.business_id = $1 AND a.code = '2100'`,
      [biz.id],
    );
    expect(Number(rows[0].balance)).toBe(0);
  });

  it("refuses to endorse without a supplier, or to one that isn't ours", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "endorse",
        createdBy: null,
      }),
    ).rejects.toThrow("supplier_required");
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "endorse",
        endorsedToSupplierId: party.otherSupplierId,
        createdBy: null,
      }),
    ).rejects.toThrow("supplier_not_found");
  });
});

describe("cheques we wrote", () => {
  it("pays the bank when presented", async () => {
    const cheque = await payable();
    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "present",
      createdBy: null,
    });
    expect(cleared.status).toBe("cleared");
    expect((await linesFor(cheque.id)).slice(-2)).toEqual([{ "2121": 3_000_000 }, { "1110": -3_000_000 }]);
  });

  it("cancelling puts the debt back to the supplier and leaves the original entry alone", async () => {
    const cheque = await payable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "cancel",
      createdBy: null,
    });
    // Two entries, not an edited one: the issue and its reversal.
    expect(await linesFor(cheque.id)).toEqual([
      { "2100": 3_000_000 },
      { "2121": -3_000_000 },
      { "2121": 3_000_000 },
      { "2100": -3_000_000 },
    ]);
  });
});

describe("returned cheques are resolved, not stranded (issue #828)", () => {
  it("settles a returned receivable into the bank and empties ۱۲۴۴", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    expect(await balanceOf("1244")).toBe(5_000_000);

    const settled = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "settle",
      occurredOn: "2026-03-20",
      createdBy: null,
    });
    expect(settled.status).toBe("cleared");
    expect(await balanceOf("1244")).toBe(0);
    expect(await balanceOf("1110")).toBe(5_000_000);
  });

  it("restores a returned receivable to A/R so a replacement cheque does not settle it twice", async () => {
    const original = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    const resolved = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "restore",
      occurredOn: "2026-03-12",
      createdBy: null,
    });
    expect(resolved.status).toBe("resolved");
    expect(await balanceOf("1244")).toBe(0);
    // Back where it started: the customer owes us again, exactly once.
    expect(await ar.getCustomerArBalance(biz.id, party.customerId)).toEqual({ balance: 0, hasLedger: true });

    const replacement = await receivable({ issueDate: "2026-03-12", dueDate: "2026-05-10" });
    expect(await balanceOf("1241")).toBe(5_000_000);
    expect(await ar.getCustomerArBalance(biz.id, party.customerId)).toEqual({
      balance: -5_000_000,
      hasLedger: true,
    });
    expect(replacement.status).toBe("on_hand");
  });

  it("posts the bank's returned-cheque charge to ۵۸۶۰ on the bounce that caused it", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      feeAmount: 150_000,
      createdBy: null,
    });
    expect(await balanceOf("5860")).toBe(150_000);
    expect(await balanceOf("1110")).toBe(-150_000);
    expect(await balanceOf("1244")).toBe(5_000_000);
  });

  it("refuses a fee on an action that is not a bounce, and a nonsense fee", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        feeAmount: 10_000,
        createdBy: null,
      }),
    ).rejects.toThrow("fee_not_supported_for_action");
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "bounce",
        feeAmount: -1,
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_fee_amount");
  });

  it("resolves a returned payable, by paying it or by putting it back on the supplier", async () => {
    const paid = await payable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: paid.id,
      action: "bounce",
      occurredOn: "2026-02-21",
      createdBy: null,
    });
    expect(await balanceOf("2122")).toBe(-3_000_000);
    const settled = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: paid.id,
      action: "settle",
      occurredOn: "2026-02-25",
      createdBy: null,
    });
    expect(settled.status).toBe("cleared");
    expect(await balanceOf("2122")).toBe(0);
    expect(await balanceOf("1110")).toBe(-3_000_000);

    // 2100 carries the first cheque's extinguished liability, so measure this
    // one's effect as a delta rather than against an empty ledger.
    const payableBefore = await balanceOf("2100");
    const restored = await payable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: restored.id,
      action: "bounce",
      occurredOn: "2026-02-21",
      createdBy: null,
    });
    const resolved = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: restored.id,
      action: "restore",
      occurredOn: "2026-02-22",
      createdBy: null,
    });
    expect(resolved.status).toBe("resolved");
    expect(await balanceOf("2122")).toBe(0);
    // The supplier is owed again — the liability is neither lost nor doubled:
    // the issue debited 2100 and the restoration credited it straight back.
    expect(await balanceOf("2100")).toBe(payableBefore);
    expect(await ap.listSupplierBalances(biz.id)).toContainEqual(
      expect.objectContaining({ supplierId: party.supplierId, balance: -3_000_000 }),
    );
  });
});

describe("branch and chronology invariants (issue #828)", () => {
  it("posts every step to the cheque's own branch, not the operator's current one", async () => {
    const otherLocation = await db.query<{ id: string }>(
      `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبه دوم') RETURNING id`,
      [biz.id],
    );
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      createdBy: null,
    });

    const { rows } = await db.query<{ location_id: string | null }>(
      `SELECT location_id FROM journal_entries WHERE source_type = 'cheque' AND source_id = $1`,
      [cheque.id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.location_id).toBe(biz.locationId);
    expect(otherLocation.rows[0].id).not.toBe(biz.locationId);
  });

  it("reports the cheque's branch with the register, and filters by it", async () => {
    const cheque = await receivable();
    const page = await cheques.listCheques(biz.id, {
      direction: "receivable",
      locationId: biz.locationId,
    });
    expect(page.cheques[0]).toMatchObject({
      id: cheque.id,
      locationId: biz.locationId,
      locationName: "Main",
    });
    const elsewhere = await cheques.listCheques(biz.id, {
      direction: "receivable",
      locationId: randomUUID(),
    });
    expect(elsewhere.cheques).toEqual([]);
  });

  it("refuses a step dated before the cheque's latest event, and allows a same-day one", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-02-10",
      createdBy: null,
    });
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "clear",
        occurredOn: "2026-01-20",
        createdBy: null,
      }),
    ).rejects.toThrow("action_before_previous_event");
    // The rejected step wrote nothing at all.
    expect(await cheques.getChequeHistory(biz.id, cheque.id)).toHaveLength(2);

    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "clear",
      occurredOn: "2026-02-10",
      createdBy: null,
    });
    expect(cleared.status).toBe("cleared");
  });

  it("reads history in accounting order: occurred_on, then insertion", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-02-10",
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "clear",
      occurredOn: "2026-02-12",
      createdBy: null,
    });
    const history = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(history.map((event) => [event.event, event.occurredOn])).toEqual([
      ["received", "2026-01-10"],
      ["deposited", "2026-02-10"],
      ["cleared", "2026-02-12"],
    ]);
  });
});

describe("the register the server filters, pages and totals (issue #828)", () => {
  it("searches Persian digits, the typed serial and the counterparty alike", async () => {
    const cheque = await receivable({ serialNumber: "123-456", counterpartyName: "مشتری طلایی" });
    await payable();

    for (const q of ["۱۲۳۴۵۶", "123456", "123-456", "طلایی"]) {
      const page = await cheques.listCheques(biz.id, { direction: "receivable", q });
      expect(page.cheques.map((c) => c.id)).toEqual([cheque.id]);
      expect(page.total).toBe(1);
    }
  });

  it("filters by the accounting-aware status groups, not only by raw status", async () => {
    const bounced = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: bounced.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    const onHand = await receivable();

    const returned = await cheques.listCheques(biz.id, {
      direction: "receivable",
      status: "returned_unresolved",
    });
    expect(returned.cheques.map((c) => c.id)).toEqual([bounced.id]);

    const outstanding = await cheques.listCheques(biz.id, {
      direction: "receivable",
      status: "outstanding",
    });
    expect(outstanding.cheques.map((c) => c.id)).toEqual([onHand.id]);

    await expect(
      cheques.listCheques(biz.id, { direction: "receivable", status: "nonsense" }),
    ).rejects.toThrow("invalid_status");
  });

  it("pages without losing or repeating a row, and keeps the totals whole-set", async () => {
    for (let i = 0; i < 3; i += 1) {
      await receivable({ dueDate: `2026-04-0${i + 1}`, amount: 1_000_000 });
    }
    const first = await cheques.listCheques(biz.id, { direction: "receivable", limit: 2 });
    expect(first.cheques).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(3);
    // The summary describes the filter, not the page.
    expect(first.summary.outstanding).toEqual({ count: 3, total: 3_000_000 });

    const second = await cheques.listCheques(biz.id, { direction: "receivable", limit: 2, offset: 2 });
    expect(second.cheques).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    const ids = [...first.cheques, ...second.cheques].map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("counts a bounce as returned-unresolved and an endorsement as neither outstanding nor settled", async () => {
    const bounced = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: bounced.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    const endorsed = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: endorsed.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      occurredOn: "2026-02-10",
      createdBy: null,
    });

    const { summary } = await cheques.listCheques(biz.id, { direction: "receivable" });
    expect(summary.returnedUnresolved).toEqual({ count: 1, total: 5_000_000 });
    expect(summary.outstanding).toEqual({ count: 0, total: 0 });
    expect(summary.settled).toEqual({ count: 0, total: 0 });
  });

  it("offers one bank per canonical spelling and filters on it", async () => {
    await receivable({ bankName: "ملت" });
    await receivable({ bankName: "بانک ملت" });
    const page = await cheques.listCheques(biz.id, { direction: "receivable", bankName: "ملت" });
    expect(page.cheques).toHaveLength(2);
    expect(page.banks).toHaveLength(1);
  });
});

describe("canonical identity and retry safety (issue #828)", () => {
  it("refuses the same instrument typed a different way", async () => {
    await receivable({ serialNumber: "123456", bankName: "ملت" });
    await expect(receivable({ serialNumber: "۱۲۳-۴۵۶", bankName: "بانک ملت" })).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("still allows a different serial at the same bank", async () => {
    await receivable({ serialNumber: "123456", bankName: "ملت" });
    await expect(receivable({ serialNumber: "123457", bankName: "بانک ملت" })).resolves.toMatchObject({
      status: "on_hand",
    });
  });

  it("returns the first cheque when the very same registration is retried", async () => {
    const key = randomUUID();
    const payload = { idempotencyKey: key, serialNumber: "AA-1" };
    const first = await receivable(payload);
    const retry = await receivable(payload);
    expect(retry.id).toBe(first.id);
    expect(retry.serialNumber).toBe("AA-1");
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).total).toBe(1);
    expect(await linesFor(first.id)).toHaveLength(2);
  });

  // The earlier version of this test sent a *different* cheque under the same
  // key and expected the first one back. That is the opposite of the contract:
  // a key identifies one request, so the same key with another payload is a
  // client bug, and answering it with an unrelated cheque hides it.
  it("refuses the same key carrying a different registration", async () => {
    const key = randomUUID();
    await receivable({ idempotencyKey: key, serialNumber: "AA-1" });
    await expect(receivable({ idempotencyKey: key, serialNumber: "AA-2" })).rejects.toThrow(
      "idempotency_key_conflict",
    );
    for (const changed of [
      { amount: 9_000_000 },
      { dueDate: "2026-04-10" },
      { customerId: null, allowUnattributed: true },
    ]) {
      await expect(
        receivable({ idempotencyKey: key, serialNumber: "AA-1", ...changed }),
      ).rejects.toThrow("idempotency_key_conflict");
    }
    // …and nothing was posted by any of the refusals.
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).total).toBe(1);
  });

  /*
   * The clock is not part of a request. `recordCheque` used to resolve an
   * omitted issue date to "today" *before* fingerprinting it, which made the
   * identity of a registration depend on when the retry arrived.
   *
   * Only `Date` is faked: the pool, its sockets and vitest's own timers keep
   * running, so these are real writes against the real database.
   */
  describe("a retry whose issue date the server filled in", () => {
    /** 2026-03-09 23:55 in Tehran — five minutes before the date rolls over. */
    const BEFORE_MIDNIGHT = new Date("2026-03-09T20:25:00.000Z");
    /** 2026-03-10 00:05 in Tehran — the same request, the next day. */
    const AFTER_MIDNIGHT = new Date("2026-03-09T20:35:00.000Z");
    /** Three weeks after the due date. */
    const LONG_AFTER = new Date("2026-04-01T09:00:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("replays the original registration when the retry crosses midnight", async () => {
      vi.setSystemTime(BEFORE_MIDNIGHT);
      const key = randomUUID();
      const payload = { idempotencyKey: key, serialNumber: "MID-1", issueDate: null, dueDate: "2026-03-10" };
      const first = await receivable(payload);
      expect(first.issueDate).toBe("2026-03-09");

      vi.setSystemTime(AFTER_MIDNIGHT);
      const retry = await receivable(payload);
      // The same answer, not a conflict and not a second instrument: what
      // the client sent has not changed, only the wall clock.
      expect(retry.id).toBe(first.id);
      expect(retry.issueDate).toBe("2026-03-09");
      expect(await countOf("MID-1")).toBe(1);
      expect(await linesFor(first.id)).toHaveLength(2);
    });

    it("replays it even after the due date has passed", async () => {
      vi.setSystemTime(BEFORE_MIDNIGHT);
      const key = randomUUID();
      const payload = { idempotencyKey: key, serialNumber: "MID-2", issueDate: null, dueDate: "2026-03-10" };
      const first = await receivable(payload);

      vi.setSystemTime(LONG_AFTER);
      // The old order threw `due_date_before_issue` here — the retry of a
      // cheque that is already on the books was refused as invalid, and the
      // caller could never learn that it had committed.
      const retry = await receivable(payload);
      expect(retry.id).toBe(first.id);
      expect(await countOf("MID-2")).toBe(1);
    });

    it("still refuses a genuinely new cheque dated after its due date", async () => {
      vi.setSystemTime(LONG_AFTER);
      // Full validation for a first write: moving the default resolution
      // after the replay lookup must not weaken it.
      await expect(
        receivable({ idempotencyKey: randomUUID(), serialNumber: "MID-3", issueDate: null, dueDate: "2026-03-10" }),
      ).rejects.toThrow("due_date_before_issue");
      expect(await countOf("MID-3")).toBe(0);
    });

    it("keeps a key issued by the previous release replayable", async () => {
      vi.setSystemTime(BEFORE_MIDNIGHT);
      const key = randomUUID();
      // What the old code stored: the fingerprint of the *resolved* date,
      // which is what sending that date explicitly produces today.
      const first = await receivable({
        idempotencyKey: key,
        serialNumber: "MID-4",
        issueDate: "2026-03-09",
        dueDate: "2026-03-10",
      });

      vi.setSystemTime(AFTER_MIDNIGHT);
      const retry = await receivable({
        idempotencyKey: key,
        serialNumber: "MID-4",
        issueDate: null,
        dueDate: "2026-03-10",
      });
      expect(retry.id).toBe(first.id);
      expect(await countOf("MID-4")).toBe(1);
    });

    it("still refuses the same key from another branch", async () => {
      vi.setSystemTime(BEFORE_MIDNIGHT);
      const key = randomUUID();
      const payload = { idempotencyKey: key, serialNumber: "MID-5", issueDate: null, dueDate: "2026-03-10" };
      await receivable(payload);
      // The branch is request context the server reads from the session, and
      // it is deliberately part of the identity: a retry sent after the
      // operator switched branch is refused rather than silently posting the
      // instrument into a different branch's books.
      await expect(receivable({ ...payload, locationId: null })).rejects.toThrow(
        "idempotency_key_conflict",
      );
      expect(await countOf("MID-5")).toBe(1);
    });
  });

  it("treats the same instrument typed differently as the same payload", async () => {
    const key = randomUUID();
    const first = await receivable({ idempotencyKey: key, serialNumber: "123456", bankName: "ملت" });
    // Identity is canonical, so the retry that re-types «۱۲۳-۴۵۶» at «بانک ملت»
    // is the same request, not a conflict.
    const retry = await receivable({
      idempotencyKey: key,
      serialNumber: "۱۲۳-۴۵۶",
      bankName: "بانک ملت",
    });
    expect(retry.id).toBe(first.id);
  });

  it("refuses a transition replay whose fee changed, and replays an identical one", async () => {
    const cheque = await receivable();
    const key = randomUUID();
    const step = {
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce" as const,
      occurredOn: "2026-03-11",
      feeAmount: 30_000,
      idempotencyKey: key,
      createdBy: null,
    };
    await cheques.transitionCheque(step);
    await expect(cheques.transitionCheque({ ...step, feeAmount: 90_000 })).rejects.toThrow(
      "idempotency_key_conflict",
    );
    const replay = await cheques.transitionCheque(step);
    expect(replay.status).toBe("bounced");
    // One bounce: the value moved once, and the charge was posted once.
    const events = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(events.filter((e) => e.event === "bounced")).toHaveLength(1);
  });

  it("serialises two concurrent retries of the same step into one posting", async () => {
    const cheque = await receivable();
    const key = randomUUID();
    const step = {
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit" as const,
      occurredOn: "2026-02-01",
      idempotencyKey: key,
      createdBy: null,
    };
    const [a, b] = await Promise.all([
      cheques.transitionCheque(step),
      cheques.transitionCheque(step),
    ]);
    expect(a.status).toBe("in_collection");
    expect(b.status).toBe("in_collection");
    const events = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(events.filter((e) => e.event === "deposited")).toHaveLength(1);
  });

  it("lets two concurrent registrations of the same key produce exactly one cheque", async () => {
    const key = randomUUID();
    const payload = { idempotencyKey: key, serialNumber: "CC-1" };
    const results = await Promise.all([receivable(payload), receivable(payload)]);
    expect(results[0].id).toBe(results[1].id);
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).total).toBe(1);
  });

  it("refuses two concurrent registrations of the same instrument", async () => {
    const settled = await Promise.allSettled([
      receivable({ serialNumber: "۱۲۳-۴۵۶", bankName: "بانک ملت" }),
      receivable({ serialNumber: "123456", bankName: "ملت" }),
    ]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).total).toBe(1);
  });

  it("keeps canonical identity inside one business", async () => {
    await receivable({ serialNumber: "123456", bankName: "ملت" });
    // The same instrument number at another business is another instrument.
    const rival = await cheques.recordCheque({
      businessId: other.id,
      locationId: null,
      direction: "receivable",
      serialNumber: "۱۲۳-۴۵۶",
      bankName: "بانک ملت",
      amount: 1_000_000,
      issueDate: "2026-01-10",
      dueDate: "2026-03-10",
      counterpartyName: "مشتری رقیب",
      allowUnattributed: true,
      createdBy: null,
    });
    expect(rival.id).toBeTruthy();
  });

  it("canonicalises in SQL exactly as it does in TypeScript", async () => {
    const samples = [
      "ملت",
      "بانک ملت",
      "بانك ملت",
      " بانک   ملت ",
      "Bank Mellat",
      "بانک",
      "صادرات/شعبه ۱",
      // The group separators 0219 folds out: Arabic thousands (U+066C),
      // Arabic decimal (U+066B), Arabic comma (U+060C) and the Latin comma.
      "۱۲۳٬۴۵۶",
      "۱۲۳٫۴۵۶",
      "۱۲۳،۴۵۶",
      "123,456",
      "۱۲۳٬۴۵۶ ",
    ];
    const { rows } = await db.query<{ bank: string; serial: string }>(
      `SELECT public.cheque_canonical_bank(v) AS bank, public.cheque_canonical_text(v) AS serial
         FROM unnest($1::text[]) AS v`,
      [samples],
    );
    expect(rows.map((r) => r.bank)).toEqual(samples.map((v) => chequesPure.canonicalBankName(v)));
    expect(rows.map((r) => r.serial)).toEqual(
      samples.map((v) => chequesPure.canonicalSerialNumber(v)),
    );
  });

  it("returns the cheque unchanged when a transition is retried with the same key", async () => {
    const cheque = await receivable();
    const key = randomUUID();
    const deposited = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      idempotencyKey: key,
      createdBy: null,
    });
    const retry = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      idempotencyKey: key,
      createdBy: null,
    });
    expect(retry.status).toBe(deposited.status);
    // One deposit entry, one deposit event — the replay posted nothing.
    expect(await linesFor(cheque.id)).toHaveLength(4);
    expect(await cheques.getChequeHistory(biz.id, cheque.id)).toHaveLength(2);
  });

  it("still refuses a genuine second attempt at the same step", async () => {
    const cheque = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      idempotencyKey: randomUUID(),
      createdBy: null,
    });
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        idempotencyKey: randomUUID(),
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_cheque_transition");
  });

  // pg_restore runs every statement with an empty search_path, and a stored
  // generated column re-runs its expression while the table is being created.
  // An unqualified call inside cheque_canonical_bank made that restore fail
  // ("function cheque_canonical_text(text) does not exist"), i.e. it broke
  // restoring any backup — so the canonicalisers must be search_path-proof.
  it("canonicalises with no search_path at all, the way a restore does", async () => {
    await db.query("SELECT pg_catalog.set_config('search_path', '', false)");
    try {
      await db.query(`CREATE TABLE public.restore_shaped_like_cheques (
        bank_name text NOT NULL,
        serial_number text NOT NULL,
        bank_name_canonical text GENERATED ALWAYS AS (public.cheque_canonical_bank(bank_name)) STORED,
        serial_number_canonical text GENERATED ALWAYS AS (public.cheque_canonical_text(serial_number)) STORED
      )`);
      await db.query(
        "INSERT INTO public.restore_shaped_like_cheques(bank_name, serial_number) VALUES ($1,$2),($3,$4)",
        ["بانك ملت", "۱۲۳-۴۵۶", "ملت", "123456"],
      );
      const rows = await db.query<{ bank_name_canonical: string; serial_number_canonical: string }>(
        "SELECT bank_name_canonical, serial_number_canonical FROM public.restore_shaped_like_cheques",
      );
      expect(rows.rows).toEqual([
        { bank_name_canonical: "ملت", serial_number_canonical: "123456" },
        { bank_name_canonical: "ملت", serial_number_canonical: "123456" },
      ]);
    } finally {
      await db.query("DROP TABLE IF EXISTS public.restore_shaped_like_cheques");
      await db.query("SELECT pg_catalog.set_config('search_path', 'public', false)");
    }
  });
});

describe("a replay answers with the first call's result (issue #828)", () => {
  it("replays the registration as it was, however far the cheque has moved since", async () => {
    const key = randomUUID();
    const serial = `R${randomUUID().slice(0, 8)}`;
    const first = await receivable({ serialNumber: serial, idempotencyKey: key });
    expect(first.status).toBe("on_hand");

    // The cheque lives on: banked, then bounced.
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: first.id,
      action: "deposit",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: first.id,
      action: "bounce",
      occurredOn: "2026-03-12",
      createdBy: null,
    });

    // The lost response finally gets retried. It is the same request, so it
    // deserves the same answer — not today's status.
    const replay = await receivable({ serialNumber: serial, idempotencyKey: key });
    expect(replay).toEqual(first);
    expect(replay.status).toBe("on_hand");

    // And nothing was written by the replay.
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cheques WHERE business_id = $1 AND idempotency_key = $2",
      [biz.id, key],
    );
    expect(rows[0].count).toBe("1");
  });

  it("replays a transition as that step left the cheque, not as later steps did", async () => {
    const cheque = await receivable();
    const key = randomUUID();
    const deposited = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      idempotencyKey: key,
      createdBy: null,
    });
    expect(deposited.status).toBe("in_collection");

    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "clear",
      occurredOn: "2026-03-14",
      createdBy: null,
    });
    expect(cleared.status).toBe("cleared");

    const replay = await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      idempotencyKey: key,
      createdBy: null,
    });
    expect(replay).toEqual(deposited);
    expect(replay.status).toBe("in_collection");
    // Two steps, two entries' worth of lines — the replay posted nothing.
    expect(await cheques.getChequeHistory(biz.id, cheque.id)).toHaveLength(3);
  });

  it("stores the result beside the key, and only when there is a key", async () => {
    const key = randomUUID();
    const withKey = await receivable({ idempotencyKey: key });
    const withoutKey = await receivable();
    const { rows } = await db.query<{ id: string; idempotency_result: unknown }>(
      "SELECT id, idempotency_result FROM cheques WHERE id = ANY($1::uuid[])",
      [[withKey.id, withoutKey.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.idempotency_result]));
    expect(byId.get(withKey.id)).toMatchObject({ id: withKey.id, status: "on_hand" });
    expect(byId.get(withoutKey.id)).toBeNull();
  });

  it("falls back to the live row for a key stored before the result column existed", async () => {
    // A row written by the pre-0219 application: key and fingerprint, no
    // stored result. Its retry cannot be refused — the posting really did
    // commit — so it keeps the old read-the-row answer.
    const key = randomUUID();
    const serial = `L${randomUUID().slice(0, 8)}`;
    const original = await receivable({ serialNumber: serial, idempotencyKey: key });
    await db.query("UPDATE cheques SET idempotency_result = NULL WHERE id = $1", [original.id]);
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "deposit",
      createdBy: null,
    });

    const replay = await receivable({ serialNumber: serial, idempotencyKey: key });
    expect(replay.id).toBe(original.id);
    expect(replay.status).toBe("in_collection");
  });

  it("keeps a stored result inside its own tenant", async () => {
    const key = randomUUID();
    const serial = `T${randomUUID().slice(0, 8)}`;
    const mine = await receivable({ serialNumber: serial, idempotencyKey: key });

    // The same key in another business is a different request entirely: it
    // registers that business's own cheque and never sees ours.
    const { rows: theirLocation } = await db.query<{ id: string }>(
      "SELECT id FROM locations WHERE business_id = $1 LIMIT 1",
      [other.id],
    );
    const theirs = await cheques.recordCheque({
      businessId: other.id,
      locationId: theirLocation[0].id,
      direction: "receivable",
      serialNumber: serial,
      bankName: "ملت",
      amount: 5_000_000,
      issueDate: "2026-01-10",
      dueDate: "2026-03-10",
      counterpartyName: "مشتری دیگر",
      allowUnattributed: true,
      idempotencyKey: key,
      createdBy: null,
    });
    expect(theirs.id).not.toBe(mine.id);
    const { rows } = await db.query<{ business_id: string }>(
      "SELECT business_id FROM cheques WHERE idempotency_key = $1",
      [key],
    );
    expect(new Set(rows.map((r) => r.business_id))).toEqual(new Set([biz.id, other.id]));
  });

  it("answers two concurrent retries of one registration with one identical result", async () => {
    const key = randomUUID();
    const serial = `C${randomUUID().slice(0, 8)}`;
    const [a, b] = await Promise.all([
      receivable({ serialNumber: serial, idempotencyKey: key }),
      receivable({ serialNumber: serial, idempotencyKey: key }),
    ]);
    expect(a).toEqual(b);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cheques WHERE business_id = $1 AND idempotency_key = $2",
      [biz.id, key],
    );
    expect(rows[0].count).toBe("1");
  });

  it("still refuses the same key carrying a changed payload, before and after the result is stored", async () => {
    const key = randomUUID();
    const first = await receivable({ idempotencyKey: key, amount: 5_000_000 });
    await expect(
      receivable({ serialNumber: first.serialNumber, idempotencyKey: key, amount: 6_000_000 }),
    ).rejects.toThrow("idempotency_key_conflict");

    const cheque = await receivable();
    const stepKey = randomUUID();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      idempotencyKey: stepKey,
      createdBy: null,
    });
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: "2026-03-11",
        idempotencyKey: stepKey,
        createdBy: null,
      }),
    ).rejects.toThrow("idempotency_key_conflict");
  });
});

describe("counterparty attribution is the ordinary path (issue #828)", () => {
  it("refuses an ordinary registration with no party, in both directions", async () => {
    await expect(receivable({ customerId: null })).rejects.toThrow("customer_required");
    await expect(payable({ supplierId: null })).rejects.toThrow("supplier_required");
  });

  it("captures an unattributed cheque only when that exception is asked for", async () => {
    const cheque = await receivable({ customerId: null, allowUnattributed: true });
    expect(cheque.customerId).toBeNull();
    expect(await linesFor(cheque.id)).toEqual([{ "1241": 5_000_000 }, { "1200": -5_000_000 }]);
  });
});

describe("replacement links (issue #828)", () => {
  it("links a replacement to the returned cheque it replaces", async () => {
    const original = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "restore",
      occurredOn: "2026-03-12",
      createdBy: null,
    });
    const replacement = await receivable({
      replacesChequeId: original.id,
      issueDate: "2026-03-12",
      dueDate: "2026-05-10",
    });
    expect(replacement.replacesChequeId).toBe(original.id);

    const page = await cheques.listCheques(biz.id, { direction: "receivable" });
    const listed = page.cheques.find((c) => c.id === replacement.id);
    expect(listed?.replacesSerialNumber).toBe(original.serialNumber);
  });

  async function returnedAndRestored(overrides: Record<string, unknown> = {}) {
    const original = await receivable(overrides);
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "restore",
      occurredOn: "2026-03-12",
      createdBy: null,
    });
    return original;
  }

  // The defect this pins: a replacement posts Dr 1241 / Cr 1200, which only
  // nets out against a `restore` that put the returned value back into 1200.
  // Registered against a still-bounced cheque it credits a receivable nobody
  // restored — the customer goes negative and 1244 stays stranded.
  it("refuses a replacement until the returned balance has been restored", async () => {
    const original = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    await expect(
      receivable({ replacesChequeId: original.id, issueDate: "2026-03-12", dueDate: "2026-05-10" }),
    ).rejects.toThrow("replaced_cheque_not_restored");

    // Nothing was written by the refusal: 1244 still carries the whole cheque.
    expect(await balanceOf("1244")).toBe(5_000_000);
    expect(await balanceOf("1200")).toBe(-5_000_000);
  });

  it("nets A/R back to zero once the restored cheque is replaced", async () => {
    const original = await returnedAndRestored();
    expect(await balanceOf("1244")).toBe(0);
    expect(await balanceOf("1200")).toBe(0);

    await receivable({
      replacesChequeId: original.id,
      issueDate: "2026-03-12",
      dueDate: "2026-05-10",
    });
    // The replacement's own entry credits 1200 again and debits 1241: the
    // customer owes nothing more than the new cheque.
    expect(await balanceOf("1200")).toBe(-5_000_000);
    expect(await balanceOf("1241")).toBe(5_000_000);
    expect(await balanceOf("1244")).toBe(0);
  });

  it("supports splitting one returned cheque into several, and refuses more than came back", async () => {
    const original = await returnedAndRestored();
    const part = (amount: number) =>
      receivable({
        replacesChequeId: original.id,
        amount,
        issueDate: "2026-03-12",
        dueDate: "2026-05-10",
      });
    await part(2_000_000);
    await part(3_000_000);
    await expect(part(1)).rejects.toThrow("replacement_exceeds_original");
    expect(await balanceOf("1241")).toBe(5_000_000);
  });

  it("lets two concurrent replacements share the original exactly once", async () => {
    const original = await returnedAndRestored();
    const attempt = () =>
      receivable({
        replacesChequeId: original.id,
        amount: 4_000_000,
        issueDate: "2026-03-12",
        dueDate: "2026-05-10",
      });
    const settled = await Promise.allSettled([attempt(), attempt()]);
    // 4m + 4m > 5m: the row lock makes the second attempt see the first.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balanceOf("1241")).toBe(4_000_000);
  });

  it("refuses a replacement for another party, another branch, or an earlier date", async () => {
    const original = await returnedAndRestored();
    const otherCustomer = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name) VALUES ($1, 'مشتری دیگر') RETURNING id",
      [biz.id],
    );
    const base = { replacesChequeId: original.id, issueDate: "2026-03-12", dueDate: "2026-05-10" };
    await expect(receivable({ ...base, customerId: otherCustomer.rows[0].id })).rejects.toThrow(
      "replaced_cheque_other_party",
    );
    await expect(receivable({ ...base, locationId: null })).rejects.toThrow(
      "replaced_cheque_other_branch",
    );
    await expect(receivable({ ...base, issueDate: "2026-03-01" })).rejects.toThrow(
      "replacement_before_resolution",
    );
  });

  it("refuses to replace a live cheque, another business's, or the other direction's", async () => {
    const live = await receivable();
    await expect(receivable({ replacesChequeId: live.id })).rejects.toThrow(
      "replaced_cheque_not_returned",
    );
    await expect(receivable({ replacesChequeId: randomUUID() })).rejects.toThrow(
      "replaced_cheque_not_found",
    );
    await expect(payable({ replacesChequeId: live.id })).rejects.toThrow(
      "replaced_cheque_not_found",
    );
  });
});

describe("guards", () => {
  it("refuses a transition the cheque's life doesn't allow", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "present",
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_cheque_transition");
  });

  it("refuses a second transition once the cheque has moved on", async () => {
    const cheque = await receivable();
    for (const _ of [0]) {
      await cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        createdBy: null,
      });
    }
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_cheque_transition");
  });

  it("refuses an invalid action date or one that predates the cheque", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: "2026-02-30",
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_occurred_on");
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: "2026-01-09",
        createdBy: null,
      }),
    ).rejects.toThrow("action_before_issue");
  });

  it("404s on another business's cheque rather than touching it", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: other.id,
        chequeId: cheque.id,
        action: "deposit",
        createdBy: null,
      }),
    ).rejects.toThrow("cheque_not_found");
  });

  it("does not make an unknown cheque look like it has an empty history", async () => {
    await expect(cheques.getChequeHistory(biz.id, randomUUID())).rejects.toThrow("cheque_not_found");
  });

  it("keeps one business's register out of another's", async () => {
    await receivable();
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).cheques).toHaveLength(1);
    expect((await cheques.listCheques(other.id, { direction: "receivable" })).cheques).toHaveLength(0);
  });

  it("refuses a step whose date falls in a locked fiscal period", async () => {
    // Nothing cheque-specific makes this work: every transition posts through
    // postJournalEntry, so migration 0024's trigger applies to a cheque exactly
    // as it does to a payroll accrual.
    const ownerRow = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
      [biz.id],
    );
    const ownerId = ownerRow.rows[0].id;

    const cheque = await receivable();
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const period = periods.find((p) => p.startsOn <= "2025-05-01" && "2025-05-01" <= p.endsOn) ?? periods[0];
    await fiscalService.setPeriodStatus(biz.id, period.id, "soft_closed", ownerId);
    await fiscalService.setPeriodStatus(biz.id, period.id, "locked", ownerId);

    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: period.startsOn,
        createdBy: null,
      }),
    ).rejects.toThrow();
  });
});

describe("the whole register reconciles to its control accounts (issue #828)", () => {
  it("walks a mixed book through every lifecycle and leaves each control account exactly right", async () => {
    // Receivables: one cleared through the bank, one endorsed to a supplier,
    // one bounced and settled, one bounced, restored and replaced, one left
    // sitting on hand.
    const cleared = await receivable({ amount: 1_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: cleared.id, action: "deposit", occurredOn: "2026-02-01", createdBy: null });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: cleared.id, action: "clear", occurredOn: "2026-03-10", createdBy: null });

    const endorsed = await receivable({ amount: 2_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: endorsed.id, action: "endorse", occurredOn: "2026-02-02", endorsedToSupplierId: party.supplierId, createdBy: null });

    const settledBack = await receivable({ amount: 3_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: settledBack.id, action: "bounce", occurredOn: "2026-03-11", feeAmount: 150_000, createdBy: null });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: settledBack.id, action: "settle", occurredOn: "2026-03-12", createdBy: null });

    const replaced = await receivable({ amount: 4_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: replaced.id, action: "bounce", occurredOn: "2026-03-11", createdBy: null });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: replaced.id, action: "restore", occurredOn: "2026-03-12", createdBy: null });
    await receivable({ amount: 4_000_000, replacesChequeId: replaced.id, issueDate: "2026-03-13", dueDate: "2026-06-10" });

    const onHand = await receivable({ amount: 500_000 });

    // Payables: one presented, one cancelled, one bounced and restored.
    const presented = await payable({ amount: 6_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: presented.id, action: "present", occurredOn: "2026-03-10", createdBy: null });
    const cancelled = await payable({ amount: 7_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: cancelled.id, action: "cancel", occurredOn: "2026-03-10", createdBy: null });
    const returnedPayable = await payable({ amount: 8_000_000 });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: returnedPayable.id, action: "bounce", occurredOn: "2026-03-11", createdBy: null });
    await cheques.transitionCheque({ businessId: biz.id, chequeId: returnedPayable.id, action: "restore", occurredOn: "2026-03-12", createdBy: null });

    expect({
      "1110": await balanceOf("1110"),
      "1200": await balanceOf("1200"),
      "1241": await balanceOf("1241"),
      "1242": await balanceOf("1242"),
      "1244": await balanceOf("1244"),
      "2100": await balanceOf("2100"),
      "2121": await balanceOf("2121"),
      "2122": await balanceOf("2122"),
      "5860": await balanceOf("5860"),
    }).toEqual({
      // Bank: +1m cleared receivable, +3m settled returned cheque, −150k fee,
      // −6m presented payable.
      "1110": 1_000_000 + 3_000_000 - 150_000 - 6_000_000,
      // A/R: credited by every receivable registered (5 cheques: 1+2+3+4+4+0.5
      // including the replacement), debited by the one restore.
      "1200": -(1_000_000 + 2_000_000 + 3_000_000 + 4_000_000 + 4_000_000 + 500_000) + 4_000_000,
      // On hand: the replacement (4m) and the untouched cheque.
      "1241": 4_000_000 + 500_000,
      "1242": 0,
      // Both returned receivables were resolved.
      "1244": 0,
      // A/P, debit-positive: issuing a payable cheque *settles* the supplier
      // (Dr 2100 / Cr 2121) for all three, +21m; endorsing a receivable to a
      // supplier settles them too, +2m; the cancellation and the restore give
      // the liability back, −7m and −8m.
      "2100": 21_000_000 + 2_000_000 - 7_000_000 - 8_000_000,
      // Issued cheques outstanding: credited on issue, debited when
      // presented/cancelled/bounced — nothing is left open.
      "2121": -(6_000_000 + 7_000_000 + 8_000_000) + 6_000_000 + 7_000_000 + 8_000_000,
      "2122": 0,
      "5860": 150_000,
    });

    // The register's own categories have to tell the same story.
    const page = await cheques.listCheques(biz.id, { direction: "receivable" });
    expect(page.summary.onHand.total).toBe(4_500_000);
    expect(page.summary.contingent.total).toBe(2_000_000);
    expect(page.summary.returnedUnresolved.total).toBe(0);
    expect(page.summary.resolved.total).toBe(4_000_000);
    const payables = await cheques.listCheques(biz.id, { direction: "payable" });
    expect(payables.summary.cancelled.total).toBe(7_000_000);
    expect(payables.summary.cleared.total).toBe(6_000_000);
    expect(payables.summary.resolved.total).toBe(8_000_000);

    // …and every A/R and A/P line this produced is attributed to a party.
    const unattributed = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN accounts a ON a.id = jl.account_id
         LEFT JOIN cheques c ON c.id = je.source_id AND je.source_type = 'cheque'
         LEFT JOIN cheque_events ev ON ev.entry_id = je.id
        WHERE a.business_id = $1 AND a.code IN ('1200', '2100')
          AND COALESCE(c.customer_id, c.supplier_id, ev.endorsed_to_supplier_id) IS NULL`,
      [biz.id],
    );
    expect(unattributed.rows[0].count).toBe("0");

    void onHand;
  });
});

describe("paging a register bigger than one page (issue #828)", () => {
  it("walks past the service's own page cap without losing or repeating a row", async () => {
    // 210 cheques, all due the same day and all for the same amount: every
    // ordering key except the row id ties, which is exactly the case that
    // used to shuffle rows between pages.
    const ids: string[] = [];
    for (let i = 0; i < 210; i += 1) {
      ids.push((await receivable({ serialNumber: `P-${String(i).padStart(4, "0")}`, amount: 1_000 })).id);
    }

    const seen: string[] = [];
    for (let offset = 0; offset < 300; offset += 50) {
      const page = await cheques.listCheques(biz.id, { direction: "receivable", limit: 50, offset });
      seen.push(...page.cheques.map((c) => c.id));
      expect(page.total).toBe(210);
      if (!page.hasMore) break;
    }
    expect(seen).toHaveLength(210);
    expect(new Set(seen).size).toBe(210);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("caps an over-large page instead of answering with the whole book", async () => {
    await receivable();
    const page = await cheques.listCheques(biz.id, { direction: "receivable", limit: 5_000 });
    expect(page.cheques.length).toBeLessThanOrEqual(200);
  });
});

describe("the due-date window (issue #828)", () => {
  it("filters by an inclusive range and validates it", async () => {
    await receivable({ serialNumber: "D-1", dueDate: "2026-03-10" });
    await receivable({ serialNumber: "D-2", dueDate: "2026-04-10" });
    await receivable({ serialNumber: "D-3", dueDate: "2026-05-10" });

    const window = await cheques.listCheques(biz.id, {
      direction: "receivable",
      dueFrom: "2026-03-10",
      dueTo: "2026-04-10",
    });
    expect(window.cheques.map((c) => c.serialNumber).sort()).toEqual(["D-1", "D-2"]);
    expect(window.total).toBe(2);

    await expect(
      cheques.listCheques(biz.id, { direction: "receivable", dueFrom: "not-a-date" }),
    ).rejects.toThrow("invalid_due_from");
    await expect(
      cheques.listCheques(biz.id, { dueFrom: "2026-05-01", dueTo: "2026-04-01" }),
    ).rejects.toThrow("invalid_due_range");
  });
});

describe("supplier attribution follows the party model (issues #826, #828)", () => {
  it("refuses a deactivated supplier alias", async () => {
    await db.query("UPDATE suppliers SET is_active = false WHERE id = $1", [party.supplierId]);
    await expect(payable()).rejects.toThrow("supplier_not_found");
  });

  it("refuses an alias whose canonical party was merged away or deactivated", async () => {
    const keeper = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, roles) VALUES ($1, 'طرف اصلی', ARRAY['supplier']) RETURNING id",
      [biz.id],
    );
    const merged = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, roles, merged_into_id)
       VALUES ($1, 'طرف ادغام‌شده', ARRAY['supplier'], $2) RETURNING id`,
      [biz.id, keeper.rows[0].id],
    );
    await db.query("UPDATE suppliers SET party_id = $1 WHERE id = $2", [
      merged.rows[0].id,
      party.supplierId,
    ]);
    await expect(payable()).rejects.toThrow("supplier_not_found");

    await db.query("UPDATE parties SET merged_into_id = NULL, is_active = false WHERE id = $1", [
      merged.rows[0].id,
    ]);
    await expect(payable()).rejects.toThrow("supplier_not_found");

    // Active and unmerged: the ordinary case still works.
    await db.query("UPDATE parties SET is_active = true WHERE id = $1", [merged.rows[0].id]);
    await expect(payable()).resolves.toMatchObject({ status: "issued" });
  });

  it("refuses an alias whose canonical party is no longer a supplier", async () => {
    // Roles are editable, and every supplier picker and A/P grouping filters
    // on them. A party that has had its supplier role taken away is one no
    // payables screen will offer again, so attributing a cheque to it would
    // post into the subledger through a door the rest of the system closed.
    const stripped = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, roles) VALUES ($1, 'مشتری صرف', ARRAY['customer']) RETURNING id",
      [biz.id],
    );
    await db.query("UPDATE suppliers SET party_id = $1 WHERE id = $2", [
      stripped.rows[0].id,
      party.supplierId,
    ]);
    await expect(payable()).rejects.toThrow("supplier_not_found");

    // Endorsement is the same attribution and is refused the same way.
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "endorse",
        endorsedToSupplierId: party.supplierId,
        createdBy: null,
      }),
    ).rejects.toThrow("supplier_not_found");

    // Give the role back and the ordinary path works again — a party may
    // hold several roles, so being a customer too is no obstacle.
    await db.query("UPDATE parties SET roles = ARRAY['customer','supplier'] WHERE id = $1", [
      stripped.rows[0].id,
    ]);
    await expect(payable()).resolves.toMatchObject({ status: "issued" });
  });

  it("refuses endorsing to a supplier that is no longer active", async () => {
    const cheque = await receivable();
    await db.query("UPDATE suppliers SET is_active = false WHERE id = $1", [party.supplierId]);
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        chequeId: cheque.id,
        action: "endorse",
        endorsedToSupplierId: party.supplierId,
        createdBy: null,
      }),
    ).rejects.toThrow("supplier_not_found");
  });
});

describe("legacy canonical duplicates are classified, not tolerated (issue #828)", () => {
  it("refuses to let the application pre-classify a new cheque", async () => {
    const cheque = await receivable();
    await expect(
      db.query("INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name, amount, issue_date, due_date, counterparty_name, canonical_duplicate_of) VALUES ($1,$2,'receivable','on_hand','X-1','ملت',1000,'2026-01-01','2026-02-01','مشتری',$3)", [
        biz.id,
        biz.locationId,
        cheque.id,
      ]),
    ).rejects.toThrow(/legacy canonical duplicate/);
  });
});

/*
 * Concurrency, verified rather than hoped for.
 *
 * `Promise.all([a(), b()])` launches two requests at once; it does not make
 * them collide. Node runs them on one thread, Postgres may finish the first
 * before the second's first statement arrives, and the assertion "exactly one
 * effect" then passes without the contended path ever having been taken — the
 * test would keep passing if the row lock were removed.
 *
 * These cases force the collision instead: a separate connection opens a
 * transaction and takes the very lock the service needs (the cheque row, or
 * the unique index entry for the retry key / the canonical instrument), the
 * contenders are started and *observed* waiting on a lock in
 * `pg_stat_activity`, and only then is the barrier released. Every contender
 * is therefore guaranteed to have reached the contended section.
 */
describe("concurrency under a forced lock barrier (issue #828)", () => {
  let barrier: Client;

  beforeEach(async () => {
    barrier = new Client({ connectionString: urlFor(databaseName) });
    await barrier.connect();
  });

  afterEach(async () => {
    // Whatever the case did, never leave a transaction (or its locks) behind.
    try {
      await barrier.query("ROLLBACK");
    } catch {
      /* already closed */
    }
    await barrier.end();
  });

  /** The backend pid holding the barrier open, so it can be excluded below. */
  async function barrierPid(): Promise<number> {
    const { rows } = await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return rows[0].pid;
  }

  /**
   * Resolves once `count` backends other than the barrier are waiting on a
   * lock. Fails loudly instead of timing out silently: a contender that never
   * blocks means the lock under test is not being taken, which is exactly the
   * defect these cases exist to catch.
   */
  async function waitUntilBlocked(count: number, pid: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    let seen = -1;
    while (Date.now() < deadline) {
      const { rows } = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
        [pid],
      );
      seen = Number(rows[0].count);
      if (seen >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} contenders to block on a lock, saw ${seen}`);
  }

  it("serialises two retries of one transition that are both inside the lock", async () => {
    const cheque = await receivable();
    const step = {
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit" as const,
      occurredOn: "2026-02-01",
      idempotencyKey: randomUUID(),
      createdBy: null,
    };

    const pid = await barrierPid();
    await barrier.query("BEGIN");
    // The row `transitionCheque` locks first.
    await barrier.query("SELECT id FROM cheques WHERE business_id = $1 AND id = $2 FOR UPDATE", [
      biz.id,
      cheque.id,
    ]);

    const first = cheques.transitionCheque(step);
    const second = cheques.transitionCheque(step);
    // Both are now queued behind the barrier, so neither can have read the
    // cheque's status yet: whatever happens next happens under contention.
    await waitUntilBlocked(2, pid);

    await barrier.query("COMMIT");
    const [a, b] = await Promise.all([first, second]);

    expect(a.status).toBe("in_collection");
    // The replay is the stored answer, not merely an equivalent one.
    expect(b).toEqual(a);
    const events = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(events.filter((e) => e.event === "deposited")).toHaveLength(1);
    expect(await balanceOf("1241")).toBe(0);
    expect(await balanceOf("1242")).toBe(5_000_000);
  });

  it("refuses a conflicting payload on the same key from inside the lock", async () => {
    const cheque = await receivable();
    const key = randomUUID();
    const step = {
      businessId: biz.id,
      chequeId: cheque.id,
      action: "bounce" as const,
      occurredOn: "2026-03-11",
      idempotencyKey: key,
      createdBy: null,
    };

    const pid = await barrierPid();
    await barrier.query("BEGIN");
    await barrier.query("SELECT id FROM cheques WHERE business_id = $1 AND id = $2 FOR UPDATE", [
      biz.id,
      cheque.id,
    ]);

    const honest = cheques.transitionCheque(step);
    const divergent = cheques.transitionCheque({ ...step, feeAmount: 120_000 });
    await waitUntilBlocked(2, pid);
    await barrier.query("COMMIT");

    const settled = await Promise.allSettled([honest, divergent]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    // Whichever of the two reaches the lock first, the other carries a
    // different request under the same key and must be refused — never
    // answered with the step it did not ask for.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "idempotency_key_conflict",
    );
    const events = await cheques.getChequeHistory(biz.id, cheque.id);
    expect(events.filter((e) => e.event === "bounced")).toHaveLength(1);
  });

  it("lets exactly one of two contended registrations with one key commit", async () => {
    const key = randomUUID();
    const serial = `LOCK-${randomUUID().slice(0, 8)}`;
    const payload = { idempotencyKey: key, serialNumber: serial };

    const pid = await barrierPid();
    await barrier.query("BEGIN");
    // No row exists yet, so the contended resource is the unique index entry
    // for the retry key. Claiming it in an uncommitted transaction makes
    // every other inserter of that key wait on this tuple.
    await barrier.query(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name, amount,
                            issue_date, due_date, counterparty_name, idempotency_key)
       VALUES ($1, $2, 'receivable', 'on_hand', $3, 'ملت', 1, '2026-01-10', '2026-03-10', 'سد', $4)`,
      [biz.id, biz.locationId, `BARRIER-${serial}`, key],
    );

    const first = receivable(payload);
    const second = receivable(payload);
    await waitUntilBlocked(2, pid);

    // Releasing the barrier by rolling back: the claim on the key disappears
    // and both contenders resume inside the race the index is there to decide.
    await barrier.query("ROLLBACK");
    const [a, b] = await Promise.all([first, second]);

    expect(a.id).toBe(b.id);
    expect(a).toEqual(b);
    expect(await countOf(serial)).toBe(1);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cheques WHERE business_id = $1 AND idempotency_key = $2",
      [biz.id, key],
    );
    expect(rows[0].count).toBe("1");
    // One registration, one journal entry, one `received` event.
    expect(await linesFor(a.id)).toHaveLength(2);
    const events = await cheques.getChequeHistory(biz.id, a.id);
    expect(events).toHaveLength(1);
  });

  it("lets exactly one of two contended registrations of one instrument commit", async () => {
    const serial = `IDENT-${randomUUID().slice(0, 6)}`;
    const pid = await barrierPid();
    await barrier.query("BEGIN");
    // The canonical identity index is the contended resource this time: the
    // same instrument typed two different ways is one instrument.
    await barrier.query(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name, amount,
                            issue_date, due_date, counterparty_name)
       VALUES ($1, $2, 'receivable', 'on_hand', $3, 'ملت', 1, '2026-01-10', '2026-03-10', 'سد')`,
      [biz.id, biz.locationId, serial],
    );

    const typed = receivable({ serialNumber: serial, bankName: "ملت" });
    const retyped = receivable({ serialNumber: `${serial}`.replace("IDENT", "IDENT"), bankName: "بانک ملت" });
    await waitUntilBlocked(2, pid);
    await barrier.query("ROLLBACK");

    const settled = await Promise.allSettled([typed, retyped]);
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await countOf(serial)).toBe(1);
  });

  it("lets two contended replacements share the original's remainder exactly once", async () => {
    const original = await returnedAndRestoredFor();
    const attempt = () =>
      receivable({
        replacesChequeId: original.id,
        amount: 4_000_000,
        issueDate: "2026-03-12",
        dueDate: "2026-05-10",
      });

    const pid = await barrierPid();
    await barrier.query("BEGIN");
    // `assertReplaceable` locks the original row before it measures what is
    // left of it; holding that row puts both replacements inside the check.
    await barrier.query("SELECT id FROM cheques WHERE business_id = $1 AND id = $2 FOR UPDATE", [
      biz.id,
      original.id,
    ]);

    const a = attempt();
    const b = attempt();
    await waitUntilBlocked(2, pid);
    await barrier.query("COMMIT");

    const settled = await Promise.allSettled([a, b]);
    // 4m + 4m against a 5m original: the second must see the first's claim.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toContain("replacement_exceeds_original");
    // And the books agree: one replacement cheque on hand, the remainder of
    // the original still unreplaced.
    expect(await balanceOf("1241")).toBe(4_000_000);
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM cheques WHERE business_id = $1 AND replaces_cheque_id = $2",
      [biz.id, original.id],
    );
    expect(rows[0].count).toBe("1");
  });

  it("keeps a foreign tenant's identical key out of the contended decision", async () => {
    const key = randomUUID();
    const serial = `TEN-${randomUUID().slice(0, 6)}`;
    const pid = await barrierPid();
    await barrier.query("BEGIN");
    await barrier.query(
      `INSERT INTO cheques (business_id, location_id, direction, status, serial_number, bank_name, amount,
                            issue_date, due_date, counterparty_name, idempotency_key)
       VALUES ($1, $2, 'receivable', 'on_hand', $3, 'ملت', 1, '2026-01-10', '2026-03-10', 'سد', $4)`,
      [biz.id, biz.locationId, `BARRIER-${serial}`, key],
    );

    const mine = receivable({ idempotencyKey: key, serialNumber: serial });
    // The other business sends the very same key at the same moment. Keys are
    // scoped per business, so this one must not queue behind our index entry
    // and must not be answered with our cheque.
    const theirs = cheques.recordCheque({
      businessId: other.id,
      locationId: null,
      direction: "receivable",
      serialNumber: serial,
      bankName: "ملت",
      amount: 1_000_000,
      issueDate: "2026-01-10",
      dueDate: "2026-03-10",
      counterpartyName: "مشتری دیگر",
      allowUnattributed: true,
      idempotencyKey: key,
      createdBy: null,
    });
    const theirCheque = await theirs;
    await waitUntilBlocked(1, pid);

    await barrier.query("ROLLBACK");
    const myCheque = await mine;
    expect(theirCheque.id).not.toBe(myCheque.id);
    expect(await countOf(serial)).toBe(1);
  });

  it("refuses both contenders when the step falls in a locked period, and posts nothing", async () => {
    const ownerRow = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
      [biz.id],
    );
    const cheque = await receivable();
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const period = periods.find((p) => p.startsOn <= "2025-05-01" && "2025-05-01" <= p.endsOn) ?? periods[0];
    await fiscalService.setPeriodStatus(biz.id, period.id, "soft_closed", ownerRow.rows[0].id);
    await fiscalService.setPeriodStatus(biz.id, period.id, "locked", ownerRow.rows[0].id);

    const step = {
      businessId: biz.id,
      chequeId: cheque.id,
      action: "deposit" as const,
      occurredOn: period.startsOn,
      idempotencyKey: randomUUID(),
      createdBy: null,
    };

    const pid = await barrierPid();
    await barrier.query("BEGIN");
    await barrier.query("SELECT id FROM cheques WHERE business_id = $1 AND id = $2 FOR UPDATE", [
      biz.id,
      cheque.id,
    ]);
    const a = cheques.transitionCheque(step);
    const b = cheques.transitionCheque(step);
    await waitUntilBlocked(2, pid);
    await barrier.query("COMMIT");

    const settled = await Promise.allSettled([a, b]);
    // A closed period is closed for both of them; winning the lock is not a
    // way past it, and a refused step leaves no event and no entry behind.
    expect(settled.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(await cheques.getChequeHistory(biz.id, cheque.id)).toHaveLength(1);
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).cheques[0].status).toBe(
      "on_hand",
    );
  });

  async function returnedAndRestoredFor() {
    const original = await receivable();
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "bounce",
      occurredOn: "2026-03-11",
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      chequeId: original.id,
      action: "restore",
      occurredOn: "2026-03-12",
      createdBy: null,
    });
    return original;
  }
});
