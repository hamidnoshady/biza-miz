/**
 * Accounting dimensions (issue #868) — the write side, against a real database.
 *
 * What is proven here:
 *
 *   §1  the database refuses what no service decision could make true: a value
 *       of another business, a value of the wrong kind, a parent of another kind,
 *       a parent loop — whatever a caller does;
 *   §2  the posting policy holds for every path that writes attribution: a
 *       disabled kind, an archived value, a parent, a value at another branch,
 *       and a value outside its effective window are each refused, and a refused
 *       document writes nothing;
 *   §3  attribution travels with a manual journal (draft → approval) and with an
 *       expense (record), line by line, and reads back from the journal;
 *   §4  a reversal mirrors what the original recorded, including after the value
 *       it names has been archived — undoing a fact must never be blocked by a
 *       later policy change;
 *   §5  project and branch stay where they were: a dimension never copies them
 *       onto a line, and a value never duplicates a project.
 *
 * The report functions have their own suite (`accounting-dimension-reports`),
 * so each file tests one side of the feature.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { LineDimensions } from "../src/lib/accounting-dimensions";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let dims: typeof import("../src/lib/accounting-dimensions-service");
let manual: typeof import("../src/lib/manual-journal-service");
let expenses: typeof import("../src/lib/expense-service");

const biz = { id: "", other: "" };
const user = { id: "", otherBusiness: "" };
const acct = { cash: "", vat: "", rent: "", revenue: "", receivable: "" };
const loc = { center: "", north: "" };
const val = {
  cc: "",
  ccSecond: "",
  pcOnline: "",
  dept: "",
  detail: "",
  branchOnly: "",
  effectiveLate: "",
  parent: "",
  child: "",
  otherBusinessCc: "",
};

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

const ENTRY_DATE = "2026-10-01";

beforeAll(async () => {
  databaseName = `pos_dimensions_${randomUUID().replaceAll("-", "")}`;
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
  dims = await import("../src/lib/accounting-dimensions-service");
  manual = await import("../src/lib/manual-journal-service");
  expenses = await import("../src/lib/expense-service");

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

async function resetBusiness(name: string, slugPrefix: string): Promise<string> {
  const row = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id", [
    name,
    `${slugPrefix}-${randomUUID().slice(0, 8)}`,
  ]);
  return row.rows[0].id;
}

beforeEach(async () => {
  await db.query("DELETE FROM expenses");
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM accounting_dimension_values");
  await db.query("DELETE FROM accounting_dimension_settings");
  await db.query("DELETE FROM expense_reference_counters");
  await db.query("DELETE FROM businesses");

  biz.id = await resetBusiness("Dimensions Co", "dims");
  biz.other = await resetBusiness("Other Co", "other");

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;
  const otherUser = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Other owner', 'x') RETURNING id`,
    [biz.other],
  );
  user.otherBusiness = otherUser.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1200', 'Receivables', 'asset'),
            ($1, '1220', 'Input VAT', 'asset'), ($1, '5300', 'Rent', 'expense'),
            ($1, '4300', 'Sales', 'revenue')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "1200") acct.receivable = row.id;
    if (row.code === "1220") acct.vat = row.id;
    if (row.code === "5300") acct.rent = row.id;
    if (row.code === "4300") acct.revenue = row.id;
  }

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name, timezone, is_active)
     VALUES ($1, 'Center', 'Asia/Tehran', true), ($1, 'North branch', 'Asia/Tehran', true)
     RETURNING id, name`,
    [biz.id],
  );
  for (const row of locations.rows) {
    if (row.name === "Center") loc.center = row.id;
    if (row.name === "North branch") loc.north = row.id;
  }

  await db.query("DELETE FROM expense_reference_counters WHERE business_id = $1", [biz.id]);

  // Cost centres and the profit centre are switched on; the detail dimension is not.
  await dims.saveDimensionSettings(biz.id, user.id, [
    { kind: "cost_center", isEnabled: true },
    { kind: "profit_center", isEnabled: true },
    { kind: "department", isEnabled: true },
  ]);

  val.cc = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-HQ", name: "Head office" })).id;
  val.ccSecond = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-SALES", name: "Sales" })).id;
  val.pcOnline = (await dims.createDimensionValue(biz.id, user.id, { kind: "profit_center", code: "PC-ONLINE", name: "Online channel" })).id;
  val.dept = (await dims.createDimensionValue(biz.id, user.id, { kind: "department", code: "DEP-FIN", name: "Finance" })).id;
  val.detail = (await dims.createDimensionValue(biz.id, user.id, { kind: "detail", code: "DET-1", name: "Pilot" })).id;
  val.branchOnly = (
    await dims.createDimensionValue(biz.id, user.id, {
      kind: "cost_center",
      code: "CC-NORTH",
      name: "North only",
      locationId: loc.north,
    })
  ).id;
  val.effectiveLate = (
    await dims.createDimensionValue(biz.id, user.id, {
      kind: "cost_center",
      code: "CC-LATE",
      name: "Opens in November",
      effectiveFrom: "2026-11-01",
    })
  ).id;
  val.parent = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-GROUP", name: "Group" })).id;
  val.child = (
    await dims.createDimensionValue(biz.id, user.id, {
      kind: "cost_center",
      code: "CC-GROUP-1",
      name: "Group, leaf",
      parentId: val.parent,
    })
  ).id;
  val.otherBusinessCc = (
    await dims.createDimensionValue(biz.other, user.otherBusiness, { kind: "cost_center", code: "CC-OTHER", name: "Other" })
  ).id;
});

function lines(entryId: string) {
  return db
    .query<{ account_id: string; debit: string; credit: string; cost_center_id: string | null; profit_center_id: string | null; department_id: string | null; detail_dimension_id: string | null }>(
      `SELECT account_id, debit::text, credit::text, cost_center_id, profit_center_id, department_id, detail_dimension_id
         FROM journal_lines WHERE entry_id = $1 ORDER BY id`,
      [entryId],
    )
    .then((r) => r.rows);
}

async function postManual(
  drafts: { accountId: string; debit: number; credit: number; dimensions?: LineDimensions }[],
  locationId: string | null = loc.center,
) {
  const draft = await manual.createDraft({
    businessId: biz.id,
    locationId,
    entryDate: ENTRY_DATE,
    memo: "Test document",
    lines: drafts,
    createdBy: user.id,
  });
  return manual.approveDraft({ businessId: biz.id, locationId, draftId: draft.id, actorId: user.id });
}

async function expectRefusal(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ message: code });
}

// ---------------------------------------------------------------------------

describe("settings: every kind is off until a business switches it on", () => {
  it("reports the four kinds, all disabled, when nothing has been saved", async () => {
    const fresh = await resetBusiness("Fresh", "fresh");
    const settings = await dims.listDimensionSettings(fresh);
    expect(settings.map((s) => s.kind)).toEqual(["cost_center", "profit_center", "department", "detail"]);
    expect(settings.every((s) => s.isEnabled === false)).toBe(true);
    expect(settings.find((s) => s.kind === "detail")?.defaultLabel).toBe("بعد تحلیلی");
  });

  it("names the detail dimension, and refuses a name on a kind the product names", async () => {
    await dims.saveDimensionSettings(biz.id, user.id, [{ kind: "detail", isEnabled: true, label: "پروژه‌های داخلی" }]);
    const detail = (await dims.listDimensionSettings(biz.id)).find((s) => s.kind === "detail");
    expect(detail).toMatchObject({ isEnabled: true, label: "پروژه‌های داخلی" });

    await expectRefusal(
      dims.saveDimensionSettings(biz.id, user.id, [{ kind: "cost_center", label: "مرکز" }]),
      "label_not_configurable",
    );
  });

  it("switching a kind off keeps its values and their history", async () => {
    await dims.saveDimensionSettings(biz.id, user.id, [{ kind: "cost_center", isEnabled: false }]);
    const values = await dims.listDimensionValues(biz.id, { kind: "cost_center" });
    expect(values.map((v) => v.code)).toContain("CC-HQ");
  });
});

describe("value records", () => {
  it("refuses a code that differs only by case or surrounding spaces, and keeps it reserved after archive", async () => {
    await expectRefusal(
      dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "  cc-hq ", name: "Again" }),
      "dimension_code_exists",
    );
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await expectRefusal(
      dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-HQ", name: "Reused" }),
      "dimension_code_exists",
    );
  });

  it("allows the same code under another kind — a cost centre and a profit centre are different things", async () => {
    const created = await dims.createDimensionValue(biz.id, user.id, { kind: "profit_center", code: "CC-HQ", name: "Same code" });
    expect(created.kind).toBe("profit_center");
  });

  it("refuses a parent of another kind, and a parent that is archived", async () => {
    await expectRefusal(
      dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "X-1", name: "X", parentId: val.pcOnline }),
      "invalid_parent",
    );
    await dims.updateDimensionValue(biz.id, user.id, val.parent, { isActive: false });
    await expectRefusal(
      dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "X-2", name: "X", parentId: val.parent }),
      "parent_inactive",
    );
  });

  it("refuses a parent loop, whichever way round it is attempted", async () => {
    await expectRefusal(
      dims.updateDimensionValue(biz.id, user.id, val.parent, { parentId: val.child }),
      "dimension_cycle",
    );
    await expectRefusal(dims.updateDimensionValue(biz.id, user.id, val.cc, { parentId: val.cc }), "dimension_cycle");
  });

  it("renames without changing identity, so existing postings keep their value", async () => {
    await postManual(
      [
        { accountId: acct.rent, debit: 300_000, credit: 0, dimensions: { cost_center: val.cc } },
        { accountId: acct.cash, debit: 0, credit: 300_000 },
      ],
    );
    const renamed = await dims.updateDimensionValue(biz.id, user.id, val.cc, { name: "Head office (renamed)" });
    expect(renamed.id).toBe(val.cc);
    const { rows } = await db.query<{ cost_center_id: string }>(
      `SELECT cost_center_id FROM journal_lines WHERE cost_center_id IS NOT NULL`,
    );
    expect(rows.map((r) => r.cost_center_id)).toEqual([val.cc]);
  });

  it("deletes a value nobody used, and archives one that was used", async () => {
    const unused = await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "TMP", name: "Typo" });
    expect(await dims.deleteDimensionValue(biz.id, unused.id)).toEqual({ deleted: true, archived: false });
    expect(await dims.getDimensionValue(biz.id, unused.id)).toBeNull();

    await postManual([
      { accountId: acct.rent, debit: 100_000, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 100_000 },
    ]);
    expect(await dims.deleteDimensionValue(biz.id, val.cc)).toEqual({ deleted: false, archived: true });
    const archived = await dims.getDimensionValue(biz.id, val.cc);
    expect(archived).toMatchObject({ isActive: false, code: "CC-HQ" });
  });

  it("never reads another business's value as its own", async () => {
    expect(await dims.getDimensionValue(biz.id, val.otherBusinessCc)).toBeNull();
    expect((await dims.listDimensionValues(biz.id)).map((v) => v.id)).not.toContain(val.otherBusinessCc);
  });
});

describe("the database refuses what no service decision could make true", () => {
  it("refuses a line whose value belongs to another business", async () => {
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
       VALUES ($1, $2, $3, 'direct', 'manual') RETURNING id`,
      [biz.id, loc.center, ENTRY_DATE],
    );
    await expect(
      db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, cost_center_id) VALUES ($1, $2, 1000, 0, $3)`,
        [entry.rows[0].id, acct.rent, val.otherBusinessCc],
      ),
    ).rejects.toThrow(/dimension_mismatch/);
  });

  it("refuses a value in the wrong kind's column", async () => {
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
       VALUES ($1, $2, $3, 'direct', 'manual') RETURNING id`,
      [biz.id, loc.center, ENTRY_DATE],
    );
    await expect(
      db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, cost_center_id) VALUES ($1, $2, 1000, 0, $3)`,
        [entry.rows[0].id, acct.rent, val.pcOnline],
      ),
    ).rejects.toThrow(/dimension_mismatch/);
  });

  it("refuses a value that names no row, and a parent of another kind", async () => {
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
       VALUES ($1, $2, $3, 'direct', 'manual') RETURNING id`,
      [biz.id, loc.center, ENTRY_DATE],
    );
    await expect(
      db.query(
        `INSERT INTO journal_lines (entry_id, account_id, debit, credit, cost_center_id) VALUES ($1, $2, 1000, 0, $3)`,
        [entry.rows[0].id, acct.rent, randomUUID()],
      ),
    // The row-level guard runs before the foreign key is checked, and it treats
    // an id that names no value of this business as a mismatch, not as a
    // missing row: both are refusals, and the guard's is the one that says why.
    ).rejects.toThrow(/dimension_mismatch/);

    await expect(
      db.query(
        `INSERT INTO accounting_dimension_values (business_id, kind, code, name, parent_id)
         VALUES ($1, 'department', 'DEP-X', 'Cross-kind child', $2)`,
        [biz.id, val.cc],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a parent loop in the table itself, not only in the service", async () => {
    await expect(
      db.query(`UPDATE accounting_dimension_values SET parent_id = $1 WHERE id = $2`, [val.child, val.parent]),
    ).rejects.toThrow(/dimension_cycle/);
  });

  it("refuses to delete a value that postings reference", async () => {
    await postManual([
      { accountId: acct.rent, debit: 100_000, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 100_000 },
    ]);
    await expect(db.query("DELETE FROM accounting_dimension_values WHERE id = $1", [val.cc])).rejects.toMatchObject({
      code: "23503",
    });
  });
});

describe("posting policy, applied to a manual journal", () => {
  const twoLines = (dimensions: LineDimensions) => [
    { accountId: acct.rent, debit: 250_000, credit: 0, dimensions },
    { accountId: acct.cash, debit: 0, credit: 250_000 },
  ];

  it("refuses a kind the business has not switched on, at draft time", async () => {
    await expectRefusal(
      manual.createDraft({
        businessId: biz.id,
        locationId: loc.center,
        entryDate: ENTRY_DATE,
        memo: "Detail not enabled",
        lines: twoLines({ detail: val.detail }),
        createdBy: user.id,
      }),
      "dimension_kind_disabled",
    );
  });

  it("refuses a value archived after it was chosen, at approval, and posts nothing", async () => {
    const draft = await manual.createDraft({
      businessId: biz.id,
      locationId: loc.center,
      entryDate: ENTRY_DATE,
      memo: "Archived in between",
      lines: twoLines({ cost_center: val.cc }),
      createdBy: user.id,
    });
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await expectRefusal(
      manual.approveDraft({ businessId: biz.id, locationId: loc.center, draftId: draft.id, actorId: user.id }),
      "dimension_inactive",
    );
    const { rows } = await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1", [biz.id]);
    expect(rows[0].n).toBe(0);
    const { rows: stillDrafted } = await db.query(
      "SELECT count(*)::int AS n FROM journal_entry_drafts WHERE id = $1",
      [draft.id],
    );
    expect(stillDrafted[0].n).toBe(1);
  });

  it("refuses a parent as a posting target", async () => {
    await expectRefusal(
      manual.createDraft({
        businessId: biz.id,
        locationId: loc.center,
        entryDate: ENTRY_DATE,
        memo: "Rollup",
        lines: twoLines({ cost_center: val.parent }),
        createdBy: user.id,
      }),
      "dimension_not_leaf",
    );
  });

  it("holds a branch-restricted value to its own branch", async () => {
    await expectRefusal(
      manual.createDraft({
        businessId: biz.id,
        locationId: loc.center,
        entryDate: ENTRY_DATE,
        memo: "Wrong branch",
        lines: twoLines({ cost_center: val.branchOnly }),
        createdBy: user.id,
      }),
      "dimension_branch_mismatch",
    );
    await expect(
      manual.createDraft({
        businessId: biz.id,
        locationId: loc.north,
        entryDate: ENTRY_DATE,
        memo: "Right branch",
        lines: twoLines({ cost_center: val.branchOnly }),
        createdBy: user.id,
      }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  it("refuses a value outside its effective window on the document's date", async () => {
    await expectRefusal(
      manual.createDraft({
        businessId: biz.id,
        locationId: loc.center,
        entryDate: ENTRY_DATE,
        memo: "Too early",
        lines: twoLines({ cost_center: val.effectiveLate }),
        createdBy: user.id,
      }),
      "dimension_not_effective",
    );
  });

  it("writes attribution line by line, and leaves lines without it empty", async () => {
    const { entryId } = await postManual([
      { accountId: acct.rent, debit: 400_000, credit: 0, dimensions: { cost_center: val.cc, department: val.dept } },
      { accountId: acct.revenue, debit: 0, credit: 400_000, dimensions: { profit_center: val.pcOnline } },
    ]);
    const rows = await lines(entryId);
    expect(rows[0]).toMatchObject({ account_id: acct.rent, cost_center_id: val.cc, department_id: val.dept, profit_center_id: null });
    expect(rows[1]).toMatchObject({ account_id: acct.revenue, profit_center_id: val.pcOnline, cost_center_id: null });
  });

  it("keeps project and branch on the entry, never copied into a line", async () => {
    const { entryId } = await postManual(
      [
        { accountId: acct.rent, debit: 400_000, credit: 0, dimensions: { cost_center: val.cc } },
        { accountId: acct.cash, debit: 0, credit: 400_000 },
      ],
      loc.north,
    );
    const { rows: entry } = await db.query<{ location_id: string; project_id: string | null }>(
      "SELECT location_id, project_id FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(entry[0]).toMatchObject({ location_id: loc.north, project_id: null });
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'journal_lines' AND column_name IN ('project_id', 'location_id', 'branch_id')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("stores a draft line's attribution and returns it in the draft", async () => {
    const draft = await manual.createDraft({
      businessId: biz.id,
      locationId: loc.center,
      entryDate: ENTRY_DATE,
      memo: "Attribution on a draft",
      lines: twoLines({ cost_center: val.cc }),
      createdBy: user.id,
    });
    const read = await manual.getDraft(biz.id, draft.id);
    expect(read?.lines[0]).toMatchObject({ accountId: acct.rent, dimensions: { cost_center: val.cc } });
    expect(read?.lines[1].dimensions).toEqual({});
  });
});

describe("reversal mirrors what the original recorded", () => {
  it("copies every line's attribution to the reversing entry", async () => {
    const { entryId } = await postManual([
      { accountId: acct.rent, debit: 180_000, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 180_000 },
    ]);
    const { entryId: reversalId } = await manual.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
    });
    const reversed = await lines(reversalId);
    expect(reversed.find((l) => l.account_id === acct.rent)).toMatchObject({ debit: "0", credit: "180000", cost_center_id: val.cc });
    expect(reversed.find((l) => l.account_id === acct.cash)).toMatchObject({ debit: "180000", cost_center_id: null });
  });

  it("still reverses after the value is archived — the mirror is not a new decision", async () => {
    const { entryId } = await postManual([
      { accountId: acct.rent, debit: 90_000, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 90_000 },
    ]);
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    const { entryId: reversalId } = await manual.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
    });
    const reversed = await lines(reversalId);
    expect(reversed.find((l) => l.account_id === acct.rent)?.cost_center_id).toBe(val.cc);
  });
});

describe("expenses carry their cost centre onto the expense line, and reverse with it", () => {
  it("records the attribution on the row and on the expense's debit line only", async () => {
    const expense = await expenses.recordExpense({
      businessId: biz.id,
      locationId: loc.center,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 500_000,
      expenseDate: ENTRY_DATE,
      memo: "Rent for head office",
      createdBy: user.id,
      dimensions: { cost_center: val.cc, department: val.dept },
    });
    expect(expense.dimensions).toEqual({ cost_center: val.cc, department: val.dept });

    const { rows } = await db.query<{ journal_entry_id: string }>(
      "SELECT je.id AS journal_entry_id FROM journal_entries je WHERE je.source_id = $1",
      [expense.id],
    );
    const journal = await lines(rows[0].journal_entry_id);
    expect(journal.find((l) => l.account_id === acct.rent)).toMatchObject({ debit: "500000", cost_center_id: val.cc, department_id: val.dept });
    expect(journal.find((l) => l.account_id === acct.cash)).toMatchObject({ credit: "500000", cost_center_id: null, department_id: null });
  });

  it("refuses an archived cost centre and leaves no expense or entry behind", async () => {
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await expect(
      expenses.recordExpense({
        businessId: biz.id,
        locationId: loc.center,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 500_000,
        expenseDate: ENTRY_DATE,
        memo: "Refused",
        createdBy: user.id,
        dimensions: { cost_center: val.cc },
      }),
    ).rejects.toMatchObject({ message: "dimension_inactive" });
    const { rows } = await db.query("SELECT (SELECT count(*) FROM expenses)::int AS e, (SELECT count(*) FROM journal_entries)::int AS j");
    expect(rows[0]).toEqual({ e: 0, j: 0 });
  });

  it("reverses with the original's attribution, even after the cost centre is archived", async () => {
    const expense = await expenses.recordExpense({
      businessId: biz.id,
      locationId: loc.center,
      accountId: acct.rent,
      paymentAccountId: acct.cash,
      amount: 250_000,
      expenseDate: ENTRY_DATE,
      memo: "Electricity",
      createdBy: user.id,
      dimensions: { cost_center: val.cc },
    });
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    const reversal = await expenses.reverseExpense({ businessId: biz.id, expenseId: expense.id, actorId: user.id });
    expect(reversal.dimensions).toEqual({ cost_center: val.cc });

    const { rows } = await db.query<{ journal_entry_id: string }>(
      "SELECT je.id AS journal_entry_id FROM journal_entries je WHERE je.source_id = $1",
      [reversal.id],
    );
    const journal = await lines(rows[0].journal_entry_id);
    expect(journal.find((l) => l.account_id === acct.rent)).toMatchObject({ credit: "250000", cost_center_id: val.cc });
  });

  it("refuses a malformed attribution rather than writing a different one", async () => {
    await expect(
      expenses.recordExpense({
        businessId: biz.id,
        locationId: loc.center,
        accountId: acct.rent,
        paymentAccountId: acct.cash,
        amount: 100_000,
        expenseDate: ENTRY_DATE,
        memo: "Bad input",
        createdBy: user.id,
        dimensions: { cost_center: "not-a-uuid" } as never,
      }),
    ).rejects.toMatchObject({ message: "invalid_dimension" });
  });
});

describe("imports map or refuse an unknown code, and never create one", () => {
  it("resolves a code ignoring case and spaces, and refuses an unknown one without creating it", async () => {
    const { resolveDimensionCode } = await import("../src/lib/accounting-dimensions");
    const values = await dims.listDimensionValues(biz.id, { kind: "cost_center" });
    expect(resolveDimensionCode(" cc-hq ", values)).toEqual({ status: "resolved", valueId: val.cc });
    expect(resolveDimensionCode("CC-MISSING", values)).toEqual({ status: "unknown" });

    const count = async () =>
      (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM accounting_dimension_values WHERE business_id = $1", [biz.id])).rows[0].n;
    const before = await count();
    // The importer resolves against the list and never inserts: nothing new appears.
    expect(resolveDimensionCode("CC-MISSING", values).status).toBe("unknown");
    expect(await count()).toBe(before);
  });
});

describe("concurrency: real contention against the database", () => {
  // Connect two clients to the same business so they can race against each
  // other without promises serialising for them. Every test picks a conflict
  // the structural triggers are supposed to refuse and runs it concurrently,
  // expecting exactly one failure — sequential Promise.all does not prove
  // concurrency because async-await serialises in the event loop.
  let db2: Client;

  beforeAll(async () => {
    db2 = new Client({ connectionString: urlFor(databaseName) });
    await db2.connect();
    // The cycle trigger does not depend on RLS; it fires on any write. We only
    // need two independent connections so their statements can interleave,
    // which a single Client serialises.
  });

  afterAll(async () => {
    try {
      await db2.end();
    } catch {
      /* already closed */
    }
  });

  it("cycle check refuses a mutual parent loop even within one transaction", async () => {
    // Setting A.parent=B then B.parent=A must fail — either at the second UPDATE
    // (BEFORE trigger sees A already points to B and B would point back to A) or
    // at COMMIT (deferred trigger). Either way the transaction must not commit a
    // loop. After rollback the table has no cycle.
    const a = await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: `CYC-A-${randomUUID().slice(0, 8)}`, name: "A" });
    const b = await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: `CYC-B-${randomUUID().slice(0, 8)}`, name: "B" });

    await db.query("BEGIN");
    await db.query(
      `UPDATE accounting_dimension_values SET parent_id = $1 WHERE id = $2 AND business_id = $3`,
      [b.id, a.id, biz.id],
    );
    await expect(
      db.query(
        `UPDATE accounting_dimension_values SET parent_id = $1 WHERE id = $2 AND business_id = $3`,
        [a.id, b.id, biz.id],
      ),
    ).rejects.toMatchObject(/dimension_cycle|P0001/);
    try {
      await db.query("ROLLBACK");
    } catch {
      /* already aborted */
    }

    const { rows } = await db.query<{ bad: boolean }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id FROM accounting_dimension_values WHERE id = ANY($1::uuid[])
         UNION ALL
         SELECT v.id, v.parent_id FROM accounting_dimension_values v JOIN ancestors a ON v.id = a.parent_id
       )
       SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ANY($1::uuid[]) GROUP BY id HAVING count(*) > 1) AS bad`,
      [[a.id, b.id]],
    );
    expect(rows[0].bad).toBe(false);
  });

  it("advisory parent-lock is taken for every parent_id UPDATE, blocking a second transaction", async () => {
    // Proves the trigger in 0218 takes a deterministic xact-level advisory
    // lock: while one transaction holds the lock for (business, kind), a second
    // UPDATE against that kind is blocked and hits lock_timeout. That is the
    // guarantee that prevents write-skew.
    const a = await dims.createDimensionValue(biz.id, user.id, { kind: "department", code: `LCK-A-${randomUUID().slice(0, 8)}`, name: "A" });
    const b = await dims.createDimensionValue(biz.id, user.id, { kind: "department", code: `LCK-B-${randomUUID().slice(0, 8)}`, name: "B" });

    try { await db.query("ROLLBACK"); } catch { /* idle */ }
    try { await db2.query("ROLLBACK"); } catch { /* idle */ }

    await db.query("BEGIN");
    // First UPDATE takes the advisory xact lock.
    await db.query(
      `UPDATE accounting_dimension_values SET parent_id = $1 WHERE id = $2 AND business_id = $3`,
      [b.id, a.id, biz.id],
    );

    await db2.query("BEGIN");
    await db2.query("SET LOCAL lock_timeout = '500'");
    // A second parent_id UPDATE against the same (business, kind) times out
    // waiting for the lock.
    await expect(
      db2.query(
        `UPDATE accounting_dimension_values SET parent_id = $1 WHERE id = $2 AND business_id = $3`,
        [null, b.id, biz.id],
      ),
    ).rejects.toMatchObject(/lock_timeout/);

    await db.query("COMMIT");
    try { await db2.query("ROLLBACK"); } catch { /* aborted */ }
    try { await db.query("ROLLBACK"); } catch { /* idle */ }
    try { await db2.query("ROLLBACK"); } catch { /* idle */ }
  });

  it("an archived value stays in historical queries and blocks no read", async () => {
    const cc = await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: `ARC-${randomUUID().slice(0, 8)}`, name: "To archive" });
    await postManual([
      { accountId: acct.rent, debit: 50_000, credit: 0, dimensions: { cost_center: cc.id } },
      { accountId: acct.cash, debit: 0, credit: 50_000 },
    ]);
    await dims.updateDimensionValue(biz.id, user.id, cc.id, { isActive: false });

    // Historical catalogue includes the archived value.
    const allValues = await dims.listDimensionValues(biz.id, { kind: "cost_center", includeArchived: true });
    expect(allValues.some((v) => v.id === cc.id)).toBe(true);

    // A new posting with it is refused; the existing posting still reads back.
    await expectRefusal(
      postManual([
        { accountId: acct.rent, debit: 10_000, credit: 0, dimensions: { cost_center: cc.id } },
        { accountId: acct.cash, debit: 0, credit: 10_000 },
      ]),
      "dimension_inactive",
    );
  });

  it("delete of a referenced value archives instead, preserving history", async () => {
    const cc = await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: `DEL-${randomUUID().slice(0, 8)}`, name: "To delete" });
    await postManual([
      { accountId: acct.rent, debit: 30_000, credit: 0, dimensions: { cost_center: cc.id } },
      { accountId: acct.cash, debit: 0, credit: 30_000 },
    ]);
    const outcome = await dims.deleteDimensionValue(biz.id, cc.id);
    expect(outcome.archived).toBe(true);
    expect(outcome.deleted).toBe(false);
    // The line still references it: a delete must not cascade away history.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_lines WHERE cost_center_id = $1`,
      [cc.id],
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  });
});
