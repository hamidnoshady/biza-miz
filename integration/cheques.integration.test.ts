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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

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

  it("returns the first cheque when a registration is retried with the same key", async () => {
    const key = randomUUID();
    const first = await receivable({ idempotencyKey: key, serialNumber: "AA-1" });
    const retry = await receivable({ idempotencyKey: key, serialNumber: "AA-2" });
    expect(retry.id).toBe(first.id);
    expect(retry.serialNumber).toBe("AA-1");
    expect((await cheques.listCheques(biz.id, { direction: "receivable" })).total).toBe(1);
    expect(await linesFor(first.id)).toHaveLength(2);
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
