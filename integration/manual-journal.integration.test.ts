/**
 * Phase 16 scope: "manual journals, properly — draft -> review -> post
 * workflow, reversal rather than deletion, ... an approval permission
 * distinct from posting." Exit criterion: "Reversing an entry leaves both
 * the original and the reversal visible and the net effect zero."
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
// Pure rules module — safe to import statically, unlike the service below,
// which must wait until DATABASE_URL points at this test's database.
import { MANUAL_LINES_MAX, MANUAL_MEMO_MAX } from "../src/lib/manual-journal";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let manualJournal: typeof import("../src/lib/manual-journal-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };
const loc = { front: "", back: "" };
const acct = { cash: "", expense: "" };
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
  databaseName = `pos_manual_journal_${randomUUID().replaceAll("-", "")}`;

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
  manualJournal = await import("../src/lib/manual-journal-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

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
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Journal Co', $1) RETURNING id",
    [`journal-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locations = await db.query<{ id: string; name: string }>(
    `INSERT INTO locations (business_id, name)
     VALUES ($1, 'Front branch'), ($1, 'Back branch')
     RETURNING id, name`,
    [biz.id],
  );
  for (const row of locations.rows) {
    if (row.name === "Front branch") loc.front = row.id;
    if (row.name === "Back branch") loc.back = row.id;
  }

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5100', 'Rent expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "5100") acct.expense = r.id;
  }
});

function balancedLines() {
  return [
    { accountId: acct.expense, debit: 100_000, credit: 0 },
    { accountId: acct.cash, debit: 0, credit: 100_000 },
  ];
}

describe("createDraft", () => {
  it("stores a draft with no journal_entries effect", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });
    expect(draft.id).toBeTruthy();

    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    expect(rows[0].n).toBe(0);

    const listed = await manualJournal.listDrafts(biz.id);
    expect(listed.total).toBe(1);
    expect(listed.drafts).toHaveLength(1);
    expect(listed.drafts[0].memo).toBe("Rent");
    expect(listed.drafts[0].lines).toHaveLength(2);
  });

  it("rejects an unbalanced draft", async () => {
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Bad",
        lines: [
          { accountId: acct.expense, debit: 100_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 90_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("not_balanced");
  });

  it("rejects a single-row draft as an incomplete entry, not an unbalanced one", async () => {
    // One row can never be a double entry. It used to be reported as
    // "not_balanced", which reads as "change the amount" when the fix is
    // "write the other side".
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Half an entry",
        lines: [{ accountId: acct.expense, debit: 100_000, credit: 0 }],
        createdBy: user.id,
      }),
    ).rejects.toThrow("too_few_lines");
  });

  it("rejects an empty memo", async () => {
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "  ",
        lines: balancedLines(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("memo_required");
  });

  it("rejects a balanced document that only touches one account", async () => {
    // Debit and credit the same account for the same amount and the totals
    // agree, so every balance check passes; what gets posted is a permanent
    // pair of postings that nets to zero and means nothing.
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Cash to cash",
        lines: [
          { accountId: acct.cash, debit: 100_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 100_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("single_account_entry");
  });

  it("refuses to post to a parent account, at draft time and at approval", async () => {
    // A parent totals its children; a posting made directly to it is invisible
    // to every report that sums the children, so the two never reconcile.
    const parent = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '5200', 'Utilities', 'expense') RETURNING id`,
      [biz.id],
    );
    const parentId = parent.rows[0].id;
    await db.query(
      `INSERT INTO accounts (business_id, parent_id, code, name, type, level)
       VALUES ($1, $2, '5210', 'Electricity', 'expense', 'moein')`,
      [biz.id, parentId],
    );

    const lines = [
      { accountId: parentId, debit: 100_000, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 100_000 },
    ];
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "To a parent",
        lines,
        createdBy: user.id,
      }),
    ).rejects.toThrow("not_a_leaf_account");

    // And again at approval: a draft written while the account was still a leaf
    // must not post once it has been given children.
    const leafOnly = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type, level) VALUES ($1, '5300', 'Repairs', 'expense', 'moein') RETURNING id`,
      [biz.id],
    );
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Leaf when drafted",
      lines: [
        { accountId: leafOnly.rows[0].id, debit: 100_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 100_000 },
      ],
      createdBy: user.id,
    });
    await db.query(
      `INSERT INTO accounts (business_id, parent_id, code, name, type, level)
       VALUES ($1, $2, '5310', 'Plumbing', 'expense', 'tafsili')`,
      [biz.id, leafOnly.rows[0].id],
    );
    await expect(
      manualJournal.approveDraft({
        businessId: biz.id,
        locationId: null,
        draftId: draft.id,
        actorId: user.id,
      }),
    ).rejects.toThrow("not_a_leaf_account");
  });

  it("rejects a memo longer than the cap", async () => {
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "x".repeat(MANUAL_MEMO_MAX + 1),
        lines: balancedLines(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("memo_too_long");
  });

  it("rejects a document with more rows than the cap", async () => {
    const many = [
      ...Array.from({ length: MANUAL_LINES_MAX }, () => ({
        accountId: acct.expense,
        debit: 10,
        credit: 0,
      })),
      { accountId: acct.cash, debit: 0, credit: 10 * MANUAL_LINES_MAX },
    ];
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Too many",
        lines: many,
        createdBy: user.id,
      }),
    ).rejects.toThrow("too_many_lines");
  });

  it("reads a draft's rows back in the order they were entered", async () => {
    // Without an explicit ordinal the rows came back in whatever order Postgres
    // returned them, so a document typed expense-then-cash could be reviewed
    // cash-then-expense. Four same-account rows with distinct amounts make the
    // order observable.
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Ordered",
      lines: [
        { accountId: acct.expense, debit: 10_000, credit: 0 },
        { accountId: acct.expense, debit: 20_000, credit: 0 },
        { accountId: acct.expense, debit: 30_000, credit: 0 },
        { accountId: acct.expense, debit: 40_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 100_000 },
      ],
      createdBy: user.id,
    });

    const expected = [10_000, 20_000, 30_000, 40_000, 0];
    expect((await manualJournal.getDraft(biz.id, draft.id))?.lines.map((l) => l.debit)).toEqual(
      expected,
    );
    const listed = await manualJournal.listDrafts(biz.id);
    expect(listed.drafts.find((d) => d.id === draft.id)?.lines.map((l) => l.debit)).toEqual(expected);

    // …and the order has to survive the posting, not just the review screen.
    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: null,
      draftId: draft.id,
      actorId: user.id,
    });
    const posted = await db.query<{ debit: string }>(
      "SELECT debit FROM journal_lines WHERE entry_id = $1 ORDER BY id",
      [entryId],
    );
    expect(posted.rows.map((r) => Number(r.debit))).toEqual(expected);
  });

  it("rejects malformed or impossible document dates before Postgres sees them", async () => {
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        entryDate: "2025-02-30",
        memo: "Bad date",
        lines: balancedLines(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_entry_date");

    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        entryDate: "not-a-date",
        memo: "Bad date",
        lines: balancedLines(),
        createdBy: user.id,
      }),
    ).rejects.toThrow("invalid_entry_date");
  });
});

describe("deleteDraft (reject)", () => {
  it("removes the draft with no trace in journal_entries", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });
    await manualJournal.deleteDraft(biz.id, draft.id);
    expect((await manualJournal.listDrafts(biz.id)).drafts).toHaveLength(0);
  });

  it("404s deleting an already-gone draft", async () => {
    await expect(
      manualJournal.deleteDraft(biz.id, randomUUID()),
    ).rejects.toThrow("draft_not_found");
  });
});

describe("approveDraft", () => {
  it("posts a real balanced journal entry and removes the draft", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });

    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: null,
      draftId: draft.id,
      actorId: user.id,
    });

    expect((await manualJournal.listDrafts(biz.id)).drafts).toHaveLength(0);

    const { rows: entryRows } = await db.query(
      "SELECT source_type, memo, entry_date::text AS entry_date FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(entryRows[0]).toMatchObject({
      source_type: "manual",
      memo: "Rent",
      entry_date: "2025-04-15",
    });

    const { rows: lineRows } = await db.query(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entryId],
    );
    expect(lineRows).toEqual([
      { account_id: acct.expense, debit: "100000", credit: "0" },
      { account_id: acct.cash, debit: "0", credit: "100000" },
    ]);
  });

  it("posts the approved document to the draft's branch, not the approver's current branch", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      entryDate: "2025-04-16",
      memo: "Branch rent",
      lines: balancedLines(),
      createdBy: user.id,
    });

    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      // Simulates an approver whose active branch differs from the drafter's.
      locationId: loc.back,
      draftId: draft.id,
      actorId: user.id,
    });

    const { rows } = await db.query<{ location_id: string | null }>(
      "SELECT location_id FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(rows[0].location_id).toBe(loc.front);
  });

  it("serializes concurrent approvals so one draft cannot create duplicate documents", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      memo: "Concurrent approval",
      lines: balancedLines(),
      createdBy: user.id,
    });

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        manualJournal.approveDraft({
          businessId: biz.id,
          locationId: loc.back,
          draftId: draft.id,
          actorId: user.id,
        }),
      ),
    );

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(rejected).toHaveLength(3);
    expect(
      rejected.map((attempt) => (attempt.reason as Error).message),
    ).toEqual(["draft_not_found", "draft_not_found", "draft_not_found"]);

    const { rows: entries } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM journal_entries WHERE business_id = $1 AND memo = 'Concurrent approval'",
      [biz.id],
    );
    expect(Number(entries[0].n)).toBe(1);
    expect((await manualJournal.listDrafts(biz.id)).drafts).toHaveLength(0);
  });

  it("404s approving a draft that doesn't exist", async () => {
    await expect(
      manualJournal.approveDraft({
        businessId: biz.id,
        locationId: null,
        draftId: randomUUID(),
        actorId: user.id,
      }),
    ).rejects.toThrow("draft_not_found");
  });

  it("rejects approving into a locked fiscal period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(
      biz.id,
      farvardin.id,
      "soft_closed",
      user.id,
    );
    await fiscalService.setPeriodStatus(
      biz.id,
      farvardin.id,
      "locked",
      user.id,
    );

    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      entryDate: farvardin.startsOn,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });

    await expect(
      manualJournal.approveDraft({
        businessId: biz.id,
        locationId: null,
        draftId: draft.id,
        actorId: user.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");

    // The rejected approval must not have consumed the draft.
    expect((await manualJournal.listDrafts(biz.id)).drafts).toHaveLength(1);
  });
});

describe("reverseEntry", () => {
  async function approvedEntryId(
    locationId: string | null = null,
  ): Promise<string> {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });
    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId,
      draftId: draft.id,
      actorId: user.id,
    });
    return entryId;
  }

  it("posts a swapped-line entry and leaves both the original and the reversal visible with net effect zero", async () => {
    const entryId = await approvedEntryId();

    const { entryId: reversalId } = await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
    });

    const { rows: originalRows } = await db.query(
      "SELECT reversed_at, reverses_entry_id FROM journal_entries WHERE id = $1",
      [entryId],
    );
    expect(originalRows[0].reversed_at).not.toBeNull();
    expect(originalRows[0].reverses_entry_id).toBeNull();

    const { rows: reversalRows } = await db.query(
      "SELECT reversed_at, reverses_entry_id, source_type FROM journal_entries WHERE id = $1",
      [reversalId],
    );
    expect(reversalRows[0].reversed_at).toBeNull();
    expect(reversalRows[0].reverses_entry_id).toBe(entryId);
    expect(reversalRows[0].source_type).toBe("manual");

    // Net effect across both entries, per account, is zero.
    const { rows: net } = await db.query(
      `SELECT account_id, SUM(debit)::bigint AS debit, SUM(credit)::bigint AS credit
         FROM journal_lines WHERE entry_id = ANY($1::uuid[]) GROUP BY account_id`,
      [[entryId, reversalId]],
    );
    for (const row of net) {
      expect(Number(row.debit)).toBe(Number(row.credit));
    }
  });

  it("posts the reversal to the original document's branch", async () => {
    const entryId = await approvedEntryId(loc.front);

    const { entryId: reversalId } = await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: loc.back,
      entryId,
      actorId: user.id,
    });

    const { rows } = await db.query<{ location_id: string | null }>(
      "SELECT location_id FROM journal_entries WHERE id = $1",
      [reversalId],
    );
    expect(rows[0].location_id).toBe(loc.front);
  });

  /**
   * Issue #821 — the hybrid/multi-branch convergence bug.
   *
   * The reversing journal was always written to the original document's
   * branch, but the sync event carried `params.locationId`, which the route
   * reads from the approver's *currently active* location. An accountant
   * standing in Branch B reversing Branch A's journal therefore wrote the row
   * to A and queued the event for B: the desktop at A never learned its own
   * document had been reversed, and the one at B was handed an entry id it
   * does not own.
   *
   * `appendSyncOutboxEvent` only records on the central server for a branch a
   * desktop is actually paired to, so each of these registers an active site
   * device first — that is also what makes "queued for the wrong branch"
   * observable rather than invisible.
   */
  async function pairDevice(locationId: string, name: string): Promise<void> {
    await db.query(
      `INSERT INTO site_devices (business_id, location_id, display_name, status)
       VALUES ($1, $2, $3, 'active')`,
      [biz.id, locationId, name],
    );
  }

  // Also issue #823 §8, which found the same defect from the sync side.
  it("queues the reversal's sync event for the original document's branch, not the approver's", async () => {
    await pairDevice(loc.front, "صندوق شعبهٔ جلو");
    await pairDevice(loc.back, "صندوق شعبهٔ پشت");
    const entryId = await approvedEntryId(loc.front);

    const { entryId: reversalId } = await manualJournal.reverseEntry({
      businessId: biz.id,
      // The approver is active in Branch B; the document lives in Branch A.
      locationId: loc.back,
      entryId,
      actorId: user.id,
      sync: { actorRole: "owner" },
    });

    const { rows: events } = await db.query<{ location_id: string; payload: { entryId: string } }>(
      `SELECT location_id, payload FROM sync_events
        WHERE event_type = 'accounting.manual_journal.reversed'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0].location_id).toBe(loc.front);
    expect(events[0].location_id).not.toBe(loc.back);
    expect(events[0].payload.entryId).toBe(entryId);

    // And the journal row itself agrees, so event and effect cannot diverge.
    const { rows } = await db.query<{ location_id: string | null }>(
      "SELECT location_id FROM journal_entries WHERE id = $1",
      [reversalId],
    );
    expect(rows[0].location_id).toBe(loc.front);
  });

  it("falls back to the approver's branch only for a document that has none of its own", async () => {
    // A business-wide entry (or one from before branches existed) has no
    // branch to route by, and `sync_events.location_id` is NOT NULL — a site's
    // own writes reach the central server only through this queue, so dropping
    // the event would lose the reversal rather than delay it. The envelope is
    // the caller's branch; the effect is still derived from the original on
    // the applying side.
    await pairDevice(loc.back, "صندوق شعبهٔ پشت");
    const entryId = await approvedEntryId(null);

    await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: loc.back,
      entryId,
      actorId: user.id,
      sync: { actorRole: "owner" },
    });

    const { rows } = await db.query<{ location_id: string }>(
      `SELECT location_id FROM sync_events
        WHERE event_type = 'accounting.manual_journal.reversed'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].location_id).toBe(loc.back);
  });

  it("queues nothing when neither the document nor the approver has a branch", async () => {
    const entryId = await approvedEntryId(null);

    await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
      sync: { actorRole: "owner" },
    });

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sync_events
        WHERE event_type = 'accounting.manual_journal.reversed'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("replays a reversal onto the original's branch even if the event reaches it labelled with another", async () => {
    // The receiving side of the bug above: `sync-domain-handlers.ts` hands the
    // *event's* location to `reverseEntryInTransaction`, which is how a
    // misrouted (or historical, wrongly-queued) event used to post a second
    // branch's copy. Deriving the branch from the original document means both
    // peers reach the same journal whatever the envelope says — that is what
    // convergence means here. A replay also queues nothing back, or the two
    // installs would trade the same reversal forever.
    await pairDevice(loc.front, "صندوق شعبهٔ جلو");
    await pairDevice(loc.back, "صندوق شعبهٔ پشت");
    const entryId = await approvedEntryId(loc.front);

    const client = await dbLib.getPool().connect();
    let reversalId = "";
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.sync_replay', 'on', true)");
      ({ entryId: reversalId } = await manualJournal.reverseEntryInTransaction(client, {
        businessId: biz.id,
        locationId: loc.back,
        entryId,
        actorId: user.id,
      }));
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const { rows } = await db.query<{ location_id: string | null }>(
      "SELECT location_id FROM journal_entries WHERE id = $1",
      [reversalId],
    );
    expect(rows[0].location_id).toBe(loc.front);

    const { rows: events } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sync_events
        WHERE event_type = 'accounting.manual_journal.reversed'`,
    );
    expect(events[0].n).toBe(0);
  });

  it("serializes concurrent reversals so one manual document receives one reversal", async () => {
    const entryId = await approvedEntryId(loc.front);

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        manualJournal.reverseEntry({
          businessId: biz.id,
          locationId: loc.back,
          entryId,
          actorId: user.id,
        }),
      ),
    );

    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(rejected).toHaveLength(3);
    expect(
      rejected.map((attempt) => (attempt.reason as Error).message),
    ).toEqual(["already_reversed", "already_reversed", "already_reversed"]);

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM journal_entries WHERE reverses_entry_id = $1",
      [entryId],
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("rejects invalid reversal dates before posting a new document", async () => {
    const entryId = await approvedEntryId();

    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId,
        actorId: user.id,
        entryDate: "2025-13-01",
      }),
    ).rejects.toThrow("invalid_entry_date");

    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*) AS n FROM journal_entries WHERE reverses_entry_id = $1",
      [entryId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("refuses to reverse a corrupted manual document with no lines", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type)
       VALUES ($1, $2, '2025-04-01', 'Broken manual', 'manual') RETURNING id`,
      [biz.id, loc.front],
    );

    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId: rows[0].id,
        actorId: user.id,
      }),
    ).rejects.toThrow("entry_has_no_lines");
  });

  it("404s reversing an entry that doesn't exist", async () => {
    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId: randomUUID(),
        actorId: user.id,
      }),
    ).rejects.toThrow("entry_not_found");
  });

  it("refuses to reverse a non-manual entry", async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, source_type) VALUES ($1, '2025-04-01', 'Order', 'order') RETURNING id`,
      [biz.id],
    );
    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId: rows[0].id,
        actorId: user.id,
      }),
    ).rejects.toThrow("not_reversible");
  });

  it("refuses to reverse an already-reversed entry", async () => {
    const entryId = await approvedEntryId();
    await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
    });

    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId,
        actorId: user.id,
      }),
    ).rejects.toThrow("already_reversed");
  });

  it("refuses to reverse a reversal itself", async () => {
    const entryId = await approvedEntryId();
    const { entryId: reversalId } = await manualJournal.reverseEntry({
      businessId: biz.id,
      locationId: null,
      entryId,
      actorId: user.id,
    });

    await expect(
      manualJournal.reverseEntry({
        businessId: biz.id,
        locationId: null,
        entryId: reversalId,
        actorId: user.id,
      }),
    ).rejects.toThrow("cannot_reverse_a_reversal");
  });
});

// ---------------------------------------------------------------------------
// Issue #823 — the workflow hardening pass over the draft → review → post
// path. Each block here is one acceptance criterion from the issue that only a
// real database can settle: what the *stored* date is, what survives a draft's
// deletion, and which branch a sync event is tagged with.
// ---------------------------------------------------------------------------

/** A branch's own calendar date right now, computed in SQL the way the service does. */
async function businessDateIn(timezone: string): Promise<string> {
  const { rows } = await db.query<{ today: string }>(
    `SELECT app_business_date(now(), $1, NULL)::text AS today`,
    [timezone],
  );
  return rows[0].today;
}

/**
 * A timezone whose calendar date differs from UTC's *right now*.
 *
 * The offsets are chosen so one of them always differs: Kiritimati (UTC+14)
 * rolls over a day for any UTC hour from 10:00, and Midway (UTC−11) for any
 * hour before 11:00. Between them every instant of the day is covered, so the
 * test cannot pass by accident at 03:00 UTC and fail at 15:00.
 */
async function timezoneDifferingFromUtc(): Promise<string> {
  const { rows } = await db.query<{ zone: string }>(
    `SELECT z AS zone
       FROM unnest(ARRAY['Pacific/Kiritimati','Pacific/Auckland','Asia/Tokyo',
                        'America/Los_Angeles','Pacific/Honolulu','Pacific/Midway']) AS z
      WHERE app_business_date(now(), z, NULL) <> app_business_date(now(), 'UTC', NULL)
      LIMIT 1`,
  );
  return rows[0].zone;
}

async function setLocationTimezone(locationId: string, timezone: string): Promise<void> {
  await db.query(`UPDATE locations SET timezone = $2 WHERE id = $1`, [locationId, timezone]);
}

describe("draft accounting date (issue #823 §2)", () => {
  it("persists a concrete date when the form means «امروز», instead of NULL", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      // undefined/null is what the screen sends when the date field is left blank.
      entryDate: null,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });

    const { rows } = await db.query<{ entry_date: string | null }>(
      `SELECT entry_date::text AS entry_date FROM journal_entry_drafts WHERE id = $1`,
      [draft.id],
    );
    // NULL here is the whole defect: approval later handed NULL to
    // postJournalEntry, which fell back to CURRENT_DATE — the *approval* day.
    expect(rows[0].entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves «امروز» in the branch's own timezone, never as a UTC date slice", async () => {
    // The location's timezone versus the server's: a café closing after
    // midnight in Tehran files today's takings under tomorrow's date if the
    // date comes from UTC (which is what CURRENT_DATE gives the Docker image).
    const zone = await timezoneDifferingFromUtc();
    await setLocationTimezone(loc.front, zone);

    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      entryDate: null,
      memo: "Late shift",
      lines: balancedLines(),
      createdBy: user.id,
    });

    const { rows } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entry_drafts WHERE id = $1`,
      [draft.id],
    );
    const [expected, utcDate] = await Promise.all([businessDateIn(zone), businessDateIn("UTC")]);
    expect(rows[0].entry_date).toBe(expected);
    // The assertion that actually pins the bug: it is not the UTC day.
    expect(rows[0].entry_date).not.toBe(utcDate);
  });

  it("posts on the draft's own date when approval happens on a later day", async () => {
    // Approved "tomorrow" by moving the draft's clock back: entry_date is
    // frozen at creation, so approving cannot re-derive it from now().
    const zone = await timezoneDifferingFromUtc();
    await setLocationTimezone(loc.front, zone);
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      entryDate: null,
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });
    const { rows: draftRows } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entry_drafts WHERE id = $1`,
      [draft.id],
    );
    await db.query(
      `UPDATE journal_entry_drafts SET created_at = created_at - interval '3 days' WHERE id = $1`,
      [draft.id],
    );

    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: null,
      draftId: draft.id,
      actorId: user.id,
    });
    const { rows } = await db.query<{ entry_date: string }>(
      `SELECT entry_date::text AS entry_date FROM journal_entries WHERE id = $1`,
      [entryId],
    );
    // …and not the day it was approved, which is three days later.
    expect(rows[0].entry_date).toBe(draftRows[0].entry_date);
    expect(rows[0].entry_date).not.toBe(await businessDateIn("UTC"));
  });

  it("resolves a legacy NULL date at approval rather than posting it as CURRENT_DATE", async () => {
    // A draft written before the fix: entry_date NULL. The service must not
    // hand that NULL to postJournalEntry.
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      entryDate: "2025-04-15",
      memo: "Legacy",
      lines: balancedLines(),
      createdBy: user.id,
    });
    await db.query(`UPDATE journal_entry_drafts SET entry_date = NULL WHERE id = $1`, [draft.id]);

    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: null,
      draftId: draft.id,
      actorId: user.id,
    });
    const { rows } = await db.query<{ entry_date: string | null }>(
      `SELECT entry_date::text AS entry_date FROM journal_entries WHERE id = $1`,
      [entryId],
    );
    expect(rows[0].entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("malformed ids (issue #823 §13)", () => {
  it("answers every draft operation with draft_not_found rather than a PostgreSQL uuid error", async () => {
    // `WHERE id = $2` against a `uuid` column raises
    // `invalid input syntax for type uuid` instead of returning no row, which
    // reaches the browser as a 500 under «خطای غیرمنتظره».
    for (const bad of ["not-a-uuid", "", "1859e1a0-bad0-4d0a-9d0a-00000000000", "null"]) {
      await expect(manualJournal.deleteDraft(biz.id, bad)).rejects.toThrow("draft_not_found");
      await expect(
        manualJournal.rejectDraft({ businessId: biz.id, draftId: bad, actorId: user.id }),
      ).rejects.toThrow("draft_not_found");
      await expect(
        manualJournal.approveDraft({
          businessId: biz.id,
          locationId: null,
          draftId: bad,
          actorId: user.id,
        }),
      ).rejects.toThrow("draft_not_found");
      expect(await manualJournal.getDraft(biz.id, bad)).toBeNull();
    }
  });

  it("refuses a malformed account id before it reaches the uuid cast", async () => {
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        entryDate: "2025-04-15",
        memo: "Bad account id",
        lines: [
          { accountId: "unknown", debit: 10_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 10_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("unknown_account");
  });
});

describe("account postability (issue #823 §9)", () => {
  it("refuses a parent whose only child is archived, the way the picker now hides it", async () => {
    // The picker used to derive "leaf" from the *active* accounts only, so a
    // parent whose only child had been archived looked postable on screen and
    // was refused here — by the reviewer, at approval time. The server's
    // answer now travels to the client; this is the invariant it asserts.
    const parent = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '5200', 'Expenses heading', 'expense') RETURNING id`,
      [biz.id],
    );
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type, parent_id, is_active)
       VALUES ($1, '5201', 'Archived child', 'expense', $2, false)`,
      [biz.id, parent.rows[0].id],
    );

    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        entryDate: "2025-04-15",
        memo: "Wrong account",
        lines: [
          { accountId: parent.rows[0].id, debit: 10_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 10_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("not_a_leaf_account");
  });
});

describe("draft idempotency (issue #823 §16)", () => {
  it("creates one draft for a retried request with the same key", async () => {
    const params = {
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
      idempotencyKey: "retry-after-timeout",
    } as const;
    const first = await manualJournal.createDraft(params);
    const second = await manualJournal.createDraft(params);

    expect(second.id).toBe(first.id);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect((await manualJournal.listDrafts(biz.id)).total).toBe(1);
  });

  it("treats a different key — and no key at all — as a separate document", async () => {
    const base = {
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    } as const;
    await manualJournal.createDraft({ ...base, idempotencyKey: "key-a" });
    await manualJournal.createDraft({ ...base, idempotencyKey: "key-b" });
    await manualJournal.createDraft(base);
    await manualJournal.createDraft(base);

    expect((await manualJournal.listDrafts(biz.id)).total).toBe(4);
  });
});

describe("workflow history (issue #823 §3)", () => {
  it("keeps the proposer and the approver on the posted entry", async () => {
    const proposer = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'manager', 'Proposer', 'x') RETURNING id`,
      [biz.id],
    );
    const approver = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'accountant', 'Approver', 'x') RETURNING id`,
      [biz.id],
    );
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: proposer.rows[0].id,
    });
    const { entryId } = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: null,
      draftId: draft.id,
      actorId: approver.rows[0].id,
    });

    const { rows } = await db.query<{
      created_by: string;
      proposed_by: string;
      proposed_at: string | null;
      approved_by: string;
      approved_at: string | null;
      draft_id: string | null;
    }>(
      `SELECT created_by, proposed_by, proposed_at::text AS proposed_at,
              approved_by, approved_at::text AS approved_at, draft_id
         FROM journal_entries WHERE id = $1`,
      [entryId],
    );
    // The draft row is deleted by the approval, so without these the only name
    // left on the entry is the approver's.
    expect(rows[0].proposed_by).toBe(proposer.rows[0].id);
    expect(rows[0].approved_by).toBe(approver.rows[0].id);
    // `created_by` keeps its long-standing meaning: whose action wrote the row.
    expect(rows[0].created_by).toBe(approver.rows[0].id);
    expect(rows[0].proposed_at).toBeTruthy();
    expect(rows[0].approved_at).toBeTruthy();
    expect(rows[0].draft_id).toBe(draft.id);
  });

  it("keeps the rejector, the time and the reason after the draft is gone", async () => {
    const reviewer = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash)
       VALUES ($1, 'accountant', 'Reviewer', 'x') RETURNING id`,
      [biz.id],
    );
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: loc.front,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });

    await manualJournal.rejectDraft({
      businessId: biz.id,
      draftId: draft.id,
      actorId: reviewer.rows[0].id,
      reason: "مبلغ با فاکتور مطابقت ندارد",
      requireReason: true,
    });

    expect((await manualJournal.listDrafts(biz.id)).total).toBe(0);
    // The history table has no foreign key to the drafts table on purpose: the
    // draft row is deleted by the very rejection being recorded.
    const { rows } = await db.query<{
      draft_id: string;
      memo: string;
      entry_date: string | null;
      proposed_by: string;
      rejected_by: string;
      rejected_at: string | null;
      rejection_reason: string | null;
    }>(
      `SELECT draft_id, memo, entry_date::text AS entry_date, proposed_by,
              rejected_by, rejected_at::text AS rejected_at, rejection_reason
         FROM journal_entry_draft_rejections WHERE business_id = $1`,
      [biz.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      draft_id: draft.id,
      memo: "Rent",
      entry_date: "2025-04-15",
      proposed_by: user.id,
      rejected_by: reviewer.rows[0].id,
      rejection_reason: "مبلغ با فاکتور مطابقت ندارد",
    });
    expect(rows[0].rejected_at).toBeTruthy();
  });

  it("refuses a rejection with no reason, so it cannot be a bare deletion", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Rent",
      lines: balancedLines(),
      createdBy: user.id,
    });
    await expect(
      manualJournal.rejectDraft({
        businessId: biz.id,
        draftId: draft.id,
        actorId: user.id,
        reason: "   ",
        requireReason: true,
      }),
    ).rejects.toThrow("rejection_reason_required");
    // …and nothing was deleted, so a refused rejection is not a lost draft.
    expect((await manualJournal.listDrafts(biz.id)).total).toBe(1);
  });

  it("lets a drafter withdraw their own draft without saying why", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      entryDate: "2025-04-15",
      memo: "Typo",
      lines: balancedLines(),
      createdBy: user.id,
    });
    const result = await manualJournal.rejectDraft({
      businessId: biz.id,
      draftId: draft.id,
      actorId: user.id,
    });
    expect(result.reason).toBeNull();
    expect((await manualJournal.listDrafts(biz.id)).total).toBe(0);
  });

  it("404s a rejection of a draft that does not exist", async () => {
    await expect(
      manualJournal.rejectDraft({
        businessId: biz.id,
        draftId: randomUUID(),
        actorId: user.id,
        reason: "nope",
      }),
    ).rejects.toThrow("draft_not_found");
  });
});

describe("draft listing (issue #823 §17, §6, §13)", () => {
  it("returns a bounded page, the real total, and the posting branch", async () => {
    for (const memo of ["a", "b", "c"]) {
      await manualJournal.createDraft({
        businessId: biz.id,
        locationId: loc.back,
        entryDate: "2025-04-15",
        memo,
        lines: balancedLines(),
        createdBy: user.id,
      });
    }

    const first = await manualJournal.listDrafts(biz.id, { limit: 2 });
    expect(first.drafts).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.hasMore).toBe(true);
    // The branch is business-wide context a reviewer cannot see anywhere else:
    // approval posts to the draft's own location, not the reviewer's.
    expect(first.drafts[0].locationName).toBe("Back branch");
    expect(first.drafts[0].proposedBy).toBe(user.id);
    expect(first.drafts[0].proposedAt).toBeTruthy();

    const second = await manualJournal.listDrafts(biz.id, { limit: 2, offset: 2 });
    expect(second.drafts).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    // Stable across pages: no row appears twice or goes missing.
    const seen = new Set([...first.drafts, ...second.drafts].map((d) => d.id));
    expect(seen.size).toBe(3);
  });

  it("caps an oversized limit rather than loading the whole queue", async () => {
    const page = await manualJournal.listDrafts(biz.id, { limit: 10_000 });
    expect(page.limit).toBe(manualJournal.MANUAL_DRAFTS_PAGE_SIZE);
  });

  it("answers a malformed draft id with null, not a PostgreSQL uuid error", async () => {
    // `WHERE id = $2` against a uuid column raises `invalid input syntax for
    // type uuid` for a non-uuid, which reaches the browser as a 500.
    expect(await manualJournal.getDraft(biz.id, "not-a-uuid")).toBeNull();
    expect(await manualJournal.getDraft(biz.id, "")).toBeNull();
  });
});
