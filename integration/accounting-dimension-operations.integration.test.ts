/**
 * Accounting dimensions (issue #868) — the operations half, against a real
 * database. The write-side policy lives in `accounting-dimensions`, the
 * reports in `accounting-dimension-reports`; this file proves the flows that
 * move attribution around:
 *
 *   §1  bulk assignment on unposted drafts: fill-blank vs overwrite vs a
 *       explicit clear, dry-run previews, per-line audit rows that outlive the
 *       draft, non-postable values refused with nothing written, and a draft
 *       that was approved mid-flight answers 409 draft_approval_race — posted
 *       lines are never touched;
 *   §2  year-end closing with dimensions: every (account × tuple) group closes
 *       against a retained-earnings line of its own tuple, each group balances
 *       within itself, an unattributed year posts exactly the old entry, and a
 *       value archived after the postings does not stop the close (the closing
 *       entry is a mirror);
 *   §3  fiscal carry-forward with dimensions: the proposal carries each
 *       balance-sheet split forward and one retained-earnings line per tuple,
 *       generation is idempotent, and the posted opening set carries the same
 *       attribution (mirror semantics for archived values);
 *   §4  the hierarchy rollup reconciles: parents include descendants without
 *       double counting and grandTotal + unassigned equals the journal total;
 *   §5  hybrid sync capture: dimension rows enter the 0190 master feed with
 *       their UUIDs as the row identity (values) and business_id|kind
 *       (settings), so a site receives exactly the ids postings reference.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { SessionPayload } from "../src/lib/auth-edge";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let dims: typeof import("../src/lib/accounting-dimensions-service");
let manual: typeof import("../src/lib/manual-journal-service");
let bulk: typeof import("../src/lib/draft-dimension-assignment");
let closing: typeof import("../src/lib/closing-service");
let opening: typeof import("../src/lib/opening-balances-service");
let reports: typeof import("../src/lib/accounting-dimension-reports-service");
let fiscal: typeof import("../src/lib/fiscal-periods-service");
let authorization: typeof import("../src/lib/authorize");

const biz = { id: "" };
const user = { id: "" };
const acct = { cash: "", rent: "", sales: "", retained: "" };
const val = { cc: "", ccAlt: "", parent: "", child: "" };

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
  databaseName = `pos_dimops_${randomUUID().replaceAll("-", "")}`;
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
  bulk = await import("../src/lib/draft-dimension-assignment");
  closing = await import("../src/lib/closing-service");
  opening = await import("../src/lib/opening-balances-service");
  reports = await import("../src/lib/accounting-dimension-reports-service");
  fiscal = await import("../src/lib/fiscal-periods-service");
  authorization = await import("../src/lib/authorize");

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
  // A confirmed fixture reset may clear even locked-period postings; normal
  // journal mutations remain guarded by migration 0216.
  await db.query("BEGIN");
  await db.query("SELECT set_config('app.factory_reset', 'true', true)");
  await db.query("DELETE FROM journal_entry_draft_dimension_audit");
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM opening_balance_lines");
  await db.query("DELETE FROM opening_balance_sets");
  // fiscal_years / fiscal_periods go with the businesses cascade below —
  // 0216's lifecycle guard refuses a direct delete of a closed year's periods.
  await db.query("DELETE FROM accounting_dimension_mappings");
  await db.query("DELETE FROM accounting_dimension_values");
  await db.query("DELETE FROM accounting_dimension_settings");
  await db.query("DELETE FROM businesses");
  await db.query("COMMIT");

  const businessRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    ["Dim Ops Co", `dimops-${randomUUID().slice(0, 8)}`],
  );
  biz.id = businessRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '5300', 'Rent', 'expense'),
            ($1, '4300', 'Sales', 'revenue'),
            ($1, '3800', 'Retained earnings', 'equity')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "5300") acct.rent = row.id;
    if (row.code === "4300") acct.sales = row.id;
    if (row.code === "3800") acct.retained = row.id;
  }

  await dims.saveDimensionSettings(biz.id, user.id, [
    { kind: "cost_center", isEnabled: true },
  ]);
  val.cc = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-A", name: "Centre A" })).id;
  val.ccAlt = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-B", name: "Centre B" })).id;
  val.parent = (await dims.createDimensionValue(biz.id, user.id, { kind: "cost_center", code: "CC-G", name: "Group" })).id;
  val.child = (
    await dims.createDimensionValue(biz.id, user.id, {
      kind: "cost_center",
      code: "CC-G1",
      name: "Group leaf",
      parentId: val.parent,
    })
  ).id;
});

async function makeDraft(
  lines: { accountId: string; debit: number; credit: number; dimensions?: Record<string, string> }[],
  memo = "Bulk fixture",
): Promise<string> {
  const draft = await manual.createDraft({
    businessId: biz.id,
    locationId: null,
    entryDate: "2026-10-01",
    memo,
    lines,
    createdBy: user.id,
  });
  return draft.id;
}

async function draftLineIds(draftId: string): Promise<{ id: string; line_no: number; cost_center_id: string | null; department_id: string | null }[]> {
  const { rows } = await db.query(
    "SELECT id, line_no, cost_center_id, department_id FROM journal_entry_draft_lines WHERE draft_id = $1 ORDER BY line_no",
    [draftId],
  );
  return rows;
}

// ---------------------------------------------------------------------------

describe("§1 bulk assignment on unposted drafts", () => {
  it("fill_blank fills only what is absent; overwrite replaces; an explicit null clears", async () => {
    const draftId = await makeDraft([
      { accountId: acct.rent, debit: 100, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 100 },
    ]);
    const fill = await bulk.assignDimensionsToDrafts({
      businessId: biz.id,
      actorId: user.id,
      draftIds: [draftId],
      dimensions: { cost_center: val.ccAlt },
      mode: "fill_blank",
      dryRun: false,
    });
    expect(fill.changedLines).toHaveLength(1);
    let lines = await draftLineIds(draftId);
    // The first line kept its centre; the blank second line was filled.
    expect(lines[0].cost_center_id).toBe(val.cc);
    expect(lines[1].cost_center_id).toBe(val.ccAlt);

    await bulk.assignDimensionsToDrafts({
      businessId: biz.id,
      actorId: user.id,
      draftIds: [draftId],
      dimensions: { cost_center: val.ccAlt },
      mode: "overwrite",
      dryRun: false,
    });
    lines = await draftLineIds(draftId);
    expect(lines[0].cost_center_id).toBe(val.ccAlt);

    await bulk.assignDimensionsToDrafts({
      businessId: biz.id,
      actorId: user.id,
      draftIds: [draftId],
      dimensions: { cost_center: null },
      mode: "overwrite",
      dryRun: false,
    });
    lines = await draftLineIds(draftId);
    expect(lines.every((l) => l.cost_center_id === null)).toBe(true);
  });

  it("dry-run reports the exact change and writes nothing", async () => {
    const draftId = await makeDraft([
      { accountId: acct.rent, debit: 50, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 50 },
    ]);
    const preview = await bulk.assignDimensionsToDrafts({
      businessId: biz.id,
      actorId: user.id,
      draftIds: [draftId],
      dimensions: { cost_center: val.cc },
      mode: "fill_blank",
      dryRun: true,
    });
    expect(preview.dryRun).toBe(true);
    expect(preview.changedLines).toHaveLength(2);
    const lines = await draftLineIds(draftId);
    expect(lines.every((l) => l.cost_center_id === null)).toBe(true);
    const audits = await db.query("SELECT 1 FROM journal_entry_draft_dimension_audit");
    expect(audits.rows).toHaveLength(0);
  });

  it("writes one audit row per changed line, and the audit outlives the draft", async () => {
    const draftId = await makeDraft([
      { accountId: acct.rent, debit: 10, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 10 },
    ]);
    await bulk.assignDimensionsToDrafts({
      businessId: biz.id,
      actorId: user.id,
      draftIds: [draftId],
      dimensions: { cost_center: val.cc },
      mode: "fill_blank",
      dryRun: false,
    });
    const before = await db.query<{ action: string; before: unknown; after: unknown }>(
      "SELECT action, before, after FROM journal_entry_draft_dimension_audit WHERE draft_id = $1",
      [draftId],
    );
    // Both lines were blank, so both changed — one audit row per changed line.
    expect(before.rows).toHaveLength(2);
    expect(before.rows[0].action).toBe("bulk_fill");
    expect((before.rows[0].after as { cost_center?: string }).cost_center).toBe(val.cc);

    await db.query("DELETE FROM journal_entry_drafts WHERE id = $1", [draftId]);
    const afterDelete = await db.query("SELECT 1 FROM journal_entry_draft_dimension_audit WHERE draft_id = $1", [draftId]);
    expect(afterDelete.rows).toHaveLength(2);
  });

  it("refuses an archived or a foreign value before anything is written", async () => {
    const draftId = await makeDraft([
      { accountId: acct.rent, debit: 10, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 10 },
    ]);
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await expect(
      bulk.assignDimensionsToDrafts({
        businessId: biz.id,
        actorId: user.id,
        draftIds: [draftId],
        dimensions: { cost_center: val.cc },
        mode: "fill_blank",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ message: "dimension_inactive", status: 400 });
    expect((await draftLineIds(draftId))[0].cost_center_id).toBeNull();

    await expect(
      bulk.assignDimensionsToDrafts({
        businessId: biz.id,
        actorId: user.id,
        draftIds: [draftId],
        dimensions: { cost_center: randomUUID() },
        mode: "fill_blank",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await draftLineIds(draftId))[0].cost_center_id).toBeNull();
  });

  it("a draft approved mid-flight answers 409 draft_approval_race — posted lines are never touched", async () => {
    const keep = await makeDraft(
      [
        { accountId: acct.rent, debit: 20, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 20 },
      ],
      "stays",
    );
    const approved = await makeDraft(
      [
        { accountId: acct.rent, debit: 30, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 30 },
      ],
      "goes",
    );
    await manual.approveDraft({ businessId: biz.id, locationId: null, draftId: approved, actorId: user.id });

    await expect(
      bulk.assignDimensionsToDrafts({
        businessId: biz.id,
        actorId: user.id,
        draftIds: [keep, approved],
        dimensions: { cost_center: val.cc },
        mode: "fill_blank",
        dryRun: false,
      }),
    ).rejects.toMatchObject({ message: "draft_approval_race", status: 409 });
    // The whole call aborted: the surviving draft was not touched either.
    expect((await draftLineIds(keep))[0].cost_center_id).toBeNull();
    const posted = await db.query<{ cost_center_id: string | null }>(
      "SELECT cost_center_id FROM journal_lines WHERE account_id = $1",
      [acct.rent],
    );
    expect(posted.rows[0].cost_center_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------

// A real Jalali fiscal year with its twelve periods — the only shape
// closeFiscalYear accepts (periods_incomplete), and the reason a posting
// after this point needs a period covering its date (0216).
async function makeYear(jy: number): Promise<{ id: string; startsOn: string; endsOn: string }> {
  const summary = await fiscal.createFiscalYear(biz.id, jy, user.id);
  return { id: summary.id, startsOn: summary.startsOn, endsOn: summary.endsOn };
}

// closeFiscalYear will not touch a year whose periods are still open
// (periods_not_ready): the workflow soft-closes each month, then the year.
async function softCloseAll(yearId: string): Promise<void> {
  const periods = await fiscal.listPeriods(biz.id, yearId);
  expect(periods).toHaveLength(12);
  for (const period of periods) {
    await withMember(() => fiscal.setPeriodStatus(biz.id, period.id, "soft_closed", user.id));
  }
}

// The fiscal close authorisation (0216) reads the session scope the real
// routes carry: business, actor and the close-period memo.
function sessionFor(userId: string): SessionPayload {
  return {
    sub: userId,
    role: "owner",
    businessId: biz.id,
    locationId: null,
    fullName: "Owner",
  };
}

async function withMember<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(
    biz.id,
    () =>
      authorization.withAuthorizationMemo(async () => {
        await authorization.authorize(sessionFor(user.id), {});
        return fn();
      }),
    { userId: user.id },
  );
}

async function closeYear(yearId: string) {
  return withMember(() => closing.closeFiscalYear(biz.id, yearId, user.id));
}

async function postAt(
  entryDate: string,
  lines: { accountId: string; debit: number; credit: number; dimensions?: Record<string, string> }[],
): Promise<void> {
  const draft = await manual.createDraft({
    businessId: biz.id,
    locationId: null,
    entryDate,
    memo: `Posting ${entryDate}`,
    lines,
    createdBy: user.id,
  });
  await manual.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });
}

describe("§2 year-end closing with dimensions", () => {
  it("closes each (account × tuple) group against a retained-earnings line of its own tuple", async () => {
    const year = await makeYear(1403);
    await postAt(year.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 1000, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 1000, credit: 0 },
    ]);
    await postAt(year.startsOn, [
      { accountId: acct.rent, debit: 400, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 400 },
    ]);
    await postAt(year.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 500, dimensions: { cost_center: val.ccAlt } },
      { accountId: acct.cash, debit: 500, credit: 0 },
    ]);

    await softCloseAll(year.id);
    const result = await closeYear(year.id);
    const closingLines = await db.query<{ account_id: string; debit: string; credit: string; cost_center_id: string | null }>(
      `SELECT jl.account_id, jl.debit::text, jl.credit::text, jl.cost_center_id
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_type = 'closing' AND je.business_id = $1 ORDER BY jl.id`,
      [biz.id],
    );
    const reLines = closingLines.rows.filter((l) => l.account_id === acct.retained);
    // One retained-earnings line per tuple: 600 on A, 500 on B.
    expect(reLines).toHaveLength(2);
    expect(reLines.find((l) => l.cost_center_id === val.cc)).toMatchObject({ credit: "600" });
    expect(reLines.find((l) => l.cost_center_id === val.ccAlt)).toMatchObject({ credit: "500" });
    // Every group balances within itself.
    for (const cc of [val.cc, val.ccAlt]) {
      const group = closingLines.rows.filter((l) => l.cost_center_id === cc);
      const debit = group.reduce((s, l) => s + BigInt(l.debit), 0n);
      const credit = group.reduce((s, l) => s + BigInt(l.credit), 0n);
      expect(debit).toBe(credit);
    }
    const totalDebit = closingLines.rows.reduce((s, l) => s + BigInt(l.debit), 0n);
    const totalCredit = closingLines.rows.reduce((s, l) => s + BigInt(l.credit), 0n);
    expect(totalDebit).toBe(totalCredit);
    expect(result.netIncome).toBe("1100");
  });

  it("an unattributed year posts exactly the old single-line entry", async () => {
    const year = await makeYear(1402);
    await postAt(year.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 700 },
      { accountId: acct.cash, debit: 700, credit: 0 },
    ]);
    await softCloseAll(year.id);
    await closeYear(year.id);
    const { rows } = await db.query<{ account_id: string; cost_center_id: string | null; debit: string; credit: string }>(
      `SELECT jl.account_id, jl.cost_center_id, jl.debit::text, jl.credit::text
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_type = 'closing' AND je.business_id = $1 ORDER BY jl.id`,
      [biz.id],
    );
    expect(rows.filter((l) => l.account_id === acct.retained)).toEqual([
      { account_id: acct.retained, cost_center_id: null, debit: "0", credit: "700" },
    ]);
  });

  it("closes over an archived value — the closing entry mirrors the year", async () => {
    const year = await makeYear(1401);
    await postAt(year.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 250, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 250, credit: 0 },
    ]);
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await softCloseAll(year.id);
    await closeYear(year.id);
    const { rows } = await db.query<{ cost_center_id: string | null; credit: string }>(
      `SELECT jl.cost_center_id, jl.credit::text
         FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE je.source_type = 'closing' AND je.business_id = $1 AND jl.account_id = $2`,
      [biz.id, acct.retained],
    );
    expect(rows).toEqual([{ cost_center_id: val.cc, credit: "250" }]);
  });

  it("refuses to close the same year twice", async () => {
    const year = await makeYear(1400);
    await softCloseAll(year.id);
    await closeYear(year.id);
    await expect(closeYear(year.id)).rejects.toMatchObject({
      message: "fiscal_year_already_closed",
    });
  });
});

// ---------------------------------------------------------------------------

describe("§3 fiscal carry-forward with dimensions", () => {
  it("carries each split forward, one retained-earnings line per tuple, idempotently", async () => {
    const year1 = await makeYear(1403);
    const year2 = await makeYear(1404);
    await postAt(year1.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 1000, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 1000, credit: 0 },
    ]);
    await postAt(year1.startsOn, [
      { accountId: acct.rent, debit: 400, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 400 },
    ]);
    // Carry-forward refuses an open prior year (prior_year_not_closed): the
    // year is closed first, and the close is what turns the P&L into the
    // retained-earnings split the proposal then carries.
    await expect(
      opening.generateCarryForward({ businessId: biz.id, fromYearId: year1.id, toYearId: year2.id, actorId: user.id }),
    ).rejects.toMatchObject({ message: "prior_year_not_closed" });
    await softCloseAll(year1.id);
    await closeYear(year1.id);

    const proposal = await opening.generateCarryForward({
      businessId: biz.id,
      fromYearId: year1.id,
      toYearId: year2.id,
      actorId: user.id,
    });
    expect(proposal.balanced).toBe(true);
    // After the close: cash +600 and retained earnings -600 on centre A.
    // The P&L is zero, so the RE line the proposal carries is the tuple's.
    const reLine = proposal.lines.find((l) => l.accountId === acct.retained);
    expect(reLine).toMatchObject({ credit: "600", dimensions: { cost_center: val.cc } });
    const cashLine = proposal.lines.find((l) => l.accountId === acct.cash);
    expect(cashLine).toMatchObject({ debit: "600", dimensions: null });
    expect(proposal.lines.find((l) => l.accountId === acct.sales)).toBeUndefined();

    const again = await opening.generateCarryForward({
      businessId: biz.id,
      fromYearId: year1.id,
      toYearId: year2.id,
      actorId: user.id,
    });
    expect(again.idempotent).toBe(true);
    expect(again.setId).toBe(proposal.setId);
  });

  it("posts the carry-forward set carrying the same attribution, even over an archived value", async () => {
    const year1 = await makeYear(1403);
    const year2 = await makeYear(1404);
    await postAt(year1.startsOn, [
      { accountId: acct.sales, debit: 0, credit: 800, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 800, credit: 0 },
    ]);
    await softCloseAll(year1.id);
    await closeYear(year1.id);
    const proposal = await opening.generateCarryForward({
      businessId: biz.id,
      fromYearId: year1.id,
      toYearId: year2.id,
      actorId: user.id,
    });
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    await opening.submitOpeningSet({ businessId: biz.id, setId: proposal.setId, actorId: user.id });
    await opening.approveOpeningSet({ businessId: biz.id, setId: proposal.setId, actorId: user.id });
    const posted = await opening.postOpeningSet({ businessId: biz.id, setId: proposal.setId, actorId: user.id });

    const { rows } = await db.query<{ account_id: string; cost_center_id: string | null; debit: string; credit: string }>(
      `SELECT jl.account_id, jl.cost_center_id, jl.debit::text, jl.credit::text
         FROM journal_lines jl WHERE jl.entry_id = $1 ORDER BY jl.id`,
      [posted.entryId],
    );
    const reLine = rows.find((l) => l.account_id === acct.retained);
    // The fact restated: attribution carried, archived value and all.
    expect(reLine).toMatchObject({ credit: "800", cost_center_id: val.cc });
  });
});

// ---------------------------------------------------------------------------

describe("§4 the hierarchy rollup reconciles to the journal", () => {
  it("rolls descendants into their parent without double counting and splits unassigned out", async () => {
    await postAt("2026-02-02", [
      { accountId: acct.rent, debit: 500, credit: 0, dimensions: { cost_center: val.child } },
      { accountId: acct.cash, debit: 0, credit: 500 },
    ]);
    await postAt("2026-02-03", [
      { accountId: acct.rent, debit: 300, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 300 },
    ]);
    await postAt("2026-02-04", [
      { accountId: acct.rent, debit: 200, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 200 },
    ]);

    const report = await reports.getDimensionRollup(biz.id, {
      kind: "cost_center",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(report.reconciled).toBe(true);
    const parentRow = report.rows.find((r) => r.id === val.parent)!;
    const childRow = report.rows.find((r) => r.id === val.child)!;
    const plainRow = report.rows.find((r) => r.id === val.cc)!;
    expect(childRow).toMatchObject({ own: 500, rolledUp: 500, depth: 1 });
    expect(parentRow).toMatchObject({ own: 0, rolledUp: 500, depth: 0 });
    expect(plainRow).toMatchObject({ own: 300, rolledUp: 300 });
    // Every line landed in exactly one bucket: own totals + unassigned = the
    // unfiltered natural total of the period (zero for a complete ledger).
    expect(report.grandTotal).toBe(800);
    expect(report.grandTotal + report.unassigned).toBe(0);
    expect(report.rows.reduce((s, r) => s + r.own, 0)).toBe(report.grandTotal);
  });

  it("keeps an archived centre in the tree as history", async () => {
    await postAt("2026-03-03", [
      { accountId: acct.rent, debit: 120, credit: 0, dimensions: { cost_center: val.cc } },
      { accountId: acct.cash, debit: 0, credit: 120 },
    ]);
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { isActive: false });
    const report = await reports.getDimensionRollup(biz.id, {
      kind: "cost_center",
      dateFrom: "2026-01-01",
      dateTo: "2026-12-31",
    });
    expect(report.rows.find((r) => r.id === val.cc)).toMatchObject({ isActive: false, own: 120 });
    expect(report.reconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("§5 hybrid sync capture for dimension master data", () => {
  it("records a value under its UUID and settings under business_id|kind", async () => {
    const clocks = await db.query<{ table_name: string; row_id: string }>(
      `SELECT table_name, row_id FROM sync_row_clocks
        WHERE table_name IN ('accounting_dimension_values', 'accounting_dimension_settings')`,
    );
    const valueRows = clocks.rows.filter((r) => r.table_name === "accounting_dimension_values");
    const settingsRows = clocks.rows.filter((r) => r.table_name === "accounting_dimension_settings");
    expect(valueRows.map((r) => r.row_id)).toContain(val.cc);
    expect(settingsRows.map((r) => r.row_id)).toContain(`${biz.id}|cost_center`);
  });

  it("an update merges by field — the changed column gets its own clock", async () => {
    await dims.updateDimensionValue(biz.id, user.id, val.cc, { name: "Centre A renamed" });
    const { rows } = await db.query<{ field_clocks: Record<string, unknown> }>(
      "SELECT field_clocks FROM sync_row_clocks WHERE table_name = 'accounting_dimension_values' AND row_id = $1",
      [val.cc],
    );
    expect(Object.keys(rows[0].field_clocks)).toContain("name");
    expect(Object.keys(rows[0].field_clocks)).not.toContain("updated_at");
  });
});
