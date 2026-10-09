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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
      chequeId: cheque.id,
      action: "deposit",
      occurredOn: "2026-03-10",
      createdBy: null,
    });
    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      locationId: biz.locationId,
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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
      chequeId: cheque.id,
      action: "deposit",
      createdBy: null,
    });
    const bounced = await cheques.transitionCheque({
      businessId: biz.id,
      locationId: biz.locationId,
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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      createdBy: null,
    });
    const before = await linesFor(cheque.id);

    const cleared = await cheques.transitionCheque({
      businessId: biz.id,
      locationId: biz.locationId,
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
      locationId: biz.locationId,
      chequeId: cheque.id,
      action: "endorse",
      endorsedToSupplierId: party.supplierId,
      createdBy: null,
    });
    await cheques.transitionCheque({
      businessId: biz.id,
      locationId: biz.locationId,
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
        locationId: biz.locationId,
        chequeId: cheque.id,
        action: "endorse",
        createdBy: null,
      }),
    ).rejects.toThrow("supplier_required");
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        locationId: biz.locationId,
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
      locationId: biz.locationId,
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
      locationId: biz.locationId,
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

describe("guards", () => {
  it("refuses a transition the cheque's life doesn't allow", async () => {
    const cheque = await receivable();
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        locationId: biz.locationId,
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
        locationId: biz.locationId,
        chequeId: cheque.id,
        action: "deposit",
        createdBy: null,
      });
    }
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        locationId: biz.locationId,
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
        locationId: biz.locationId,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: "2026-02-30",
        createdBy: null,
      }),
    ).rejects.toThrow("invalid_occurred_on");
    await expect(
      cheques.transitionCheque({
        businessId: biz.id,
        locationId: biz.locationId,
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
        locationId: null,
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
    expect(await cheques.listCheques(biz.id, "receivable")).toHaveLength(1);
    expect(await cheques.listCheques(other.id, "receivable")).toHaveLength(0);
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
        locationId: biz.locationId,
        chequeId: cheque.id,
        action: "deposit",
        occurredOn: period.startsOn,
        createdBy: null,
      }),
    ).rejects.toThrow();
  });
});
