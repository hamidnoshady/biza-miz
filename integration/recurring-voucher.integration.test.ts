/**
 * Recurring journal vouchers — the database contract (issue #1323 / ESH-160).
 *
 * These tests are the acceptance criteria the issue names, expressed against a
 * real PostgreSQL: one draft per intended month, exactly one occurrence and one
 * journal effect under two concurrent generators, approval through the existing
 * manual-journal workflow, prospective template edits, locked-period and
 * archived-account holds, skip/retry, and tenant isolation.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { jalaliToIsoDate } from "../src/lib/jalali";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let manualJournal: typeof import("../src/lib/manual-journal-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let recurring: typeof import("../src/lib/recurring-voucher-service");

const iso = (jy: number, jm: number, jd: number) => jalaliToIsoDate(jy, jm, jd);

const biz = { id: "" };
const loc = { id: "" };
const acct = { cash: "", expense: "", secondExpense: "" };
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

function input(overrides: Partial<Parameters<typeof recurring.createRecurringTemplate>[0]["input"]> = {}) {
  return {
    name: "اجارهٔ دفتر",
    description: "قرارداد سالانه",
    memo: "اجارهٔ ماهانهٔ دفتر",
    frequency: "monthly",
    monthEndPolicy: "clamp",
    startDate: iso(1404, 6, 31),
    endDate: null,
    lines: [
      { accountId: acct.expense, debit: 1_000_000, credit: 0 },
      { accountId: acct.cash, debit: 0, credit: 1_000_000 },
    ],
    ...overrides,
  };
}

async function draftCount(): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM journal_entry_drafts WHERE business_id = $1",
    [biz.id],
  );
  return rows[0].n;
}

async function occurrenceRows(templateId: string) {
  const { rows } = await db.query<{
    scheduled_date: string;
    status: string;
    draft_id: string | null;
    entry_id: string | null;
    held_reason: string | null;
  }>(
    `SELECT scheduled_date::text AS scheduled_date, status, draft_id, entry_id, held_reason
       FROM recurring_journal_occurrences WHERE template_id = $1 ORDER BY scheduled_date`,
    [templateId],
  );
  return rows;
}

beforeAll(async () => {
  databaseName = `pos_recurring_voucher_${randomUUID().replaceAll("-", "")}`;
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
  recurring = await import("../src/lib/recurring-voucher-service");

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

beforeEach(async () => {
  await db.query("DELETE FROM recurring_journal_occurrence_events");
  await db.query("DELETE FROM recurring_journal_occurrences");
  await db.query("DELETE FROM recurring_journal_template_versions");
  await db.query("DELETE FROM recurring_journal_template_lines");
  await db.query("DELETE FROM recurring_journal_templates");
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Recurring Co', $1) RETURNING id",
    [`recurring-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const location = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  loc.id = location.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash)
     VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '5100', 'Rent expense', 'expense'),
            ($1, '5200', 'Insurance expense', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const row of accounts.rows) {
    if (row.code === "1100") acct.cash = row.id;
    if (row.code === "5100") acct.expense = row.id;
    if (row.code === "5200") acct.secondExpense = row.id;
  }
});

describe("draft generation", () => {
  it("creates one balanced draft for each intended month and nothing in the ledger", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });

    const result = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 8, 30),
    });
    expect(result.draftsCreated).toBe(3);

    const occurrences = await occurrenceRows(id);
    expect(occurrences.map((row) => row.scheduled_date)).toEqual([
      iso(1404, 6, 31),
      iso(1404, 7, 30),
      iso(1404, 8, 30),
    ]);
    expect(occurrences.every((row) => row.status === "draft" && row.draft_id)).toBe(true);
    expect(await draftCount()).toBe(3);

    const { rows: entries } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    expect(entries[0].n).toBe(0);

    const drafts = await manualJournal.listDrafts(biz.id);
    for (const draft of drafts.drafts) {
      expect(draft.lines.reduce((sum, line) => sum + line.debit, 0)).toBe(
        draft.lines.reduce((sum, line) => sum + line.credit, 0),
      );
      expect(draft.lines.reduce((sum, line) => sum + line.debit, 0)).toBe(1_000_000);
    }
  });

  it("makes two concurrent generators produce one occurrence and one draft per date", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    const asOfDate = iso(1404, 7, 30);

    const [a, b] = await Promise.all([
      recurring.generateForTemplate({ businessId: biz.id, templateId: id, asOfDate }),
      recurring.generateForTemplate({ businessId: biz.id, templateId: id, asOfDate }),
    ]);
    expect(a.draftsCreated + b.draftsCreated).toBe(2);
    expect(await draftCount()).toBe(2);
    const occurrences = await occurrenceRows(id);
    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences.map((row) => row.scheduled_date)).size).toBe(2);

    // A replay of the same window (a restart, a retried tick) changes nothing.
    const replay = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate,
    });
    expect(replay.draftsCreated).toBe(0);
    expect(await draftCount()).toBe(2);
  });

  it("caps a long catch-up and lets the next pass continue", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input({ startDate: iso(1400, 1, 1) }),
    });
    const first = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1405, 12, 29),
    });
    expect(first.draftsCreated).toBe(36);
    const second = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1405, 12, 29),
    });
    expect(second.draftsCreated).toBe(36);
    const rows = await occurrenceRows(id);
    expect(rows).toHaveLength(72);
    expect(new Set(rows.map((row) => row.scheduled_date)).size).toBe(72);
  });
});

describe("approval and posting", () => {
  it("posts exactly once through the existing manual-journal approval and records it on the occurrence", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404, user.id);
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    const [occurrence] = await occurrenceRows(id);
    expect(occurrence.draft_id).toBeTruthy();

    const approved = await manualJournal.approveDraft({
      businessId: biz.id,
      locationId: loc.id,
      draftId: occurrence.draft_id!,
      actorId: user.id,
    });

    const [settled] = await occurrenceRows(id);
    expect(settled.status).toBe("posted");
    expect(settled.entry_id).toBe(approved.entryId);

    const { rows: entries } = await db.query<{ n: number; entry_date: string; memo: string }>(
      "SELECT count(*)::int AS n, min(entry_date)::text AS entry_date, min(memo) AS memo FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    expect(entries[0].n).toBe(1);
    // The document's date is the template's scheduled date, not approval day.
    expect(entries[0].entry_date).toBe(iso(1404, 6, 31));
    expect(entries[0].memo).toBe("اجارهٔ ماهانهٔ دفتر");

    // Approving again cannot post a second entry; the draft is gone.
    await expect(
      manualJournal.approveDraft({
        businessId: biz.id,
        locationId: loc.id,
        draftId: occurrence.draft_id!,
        actorId: user.id,
      }),
    ).rejects.toMatchObject({ message: "draft_not_found" });
    const { rows: after } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM journal_entries WHERE business_id = $1",
      [biz.id],
    );
    expect(after[0].n).toBe(1);
  });

  it("marks the occurrence skipped when its draft is rejected, so it cannot post later", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    const [occurrence] = await occurrenceRows(id);
    await manualJournal.rejectDraft({
      businessId: biz.id,
      draftId: occurrence.draft_id!,
      actorId: user.id,
      reason: "مبلغ اشتباه",
      requireReason: true,
    });
    const [settled] = await occurrenceRows(id);
    expect(settled.status).toBe("skipped");
    expect(settled.held_reason).toBe("draft_rejected");
    expect(await draftCount()).toBe(0);
  });
});

describe("prospective edits", () => {
  it("leaves prior drafts and posted entries untouched and applies the new version to future dates", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    const [first] = await occurrenceRows(id);
    const before = await manualJournal.getDraft(biz.id, first.draft_id!);
    expect(before?.lines[0].debit).toBe(1_000_000);

    const edited = await recurring.updateRecurringTemplate({
      businessId: biz.id,
      templateId: id,
      actorId: user.id,
      input: input({
        memo: "اجارهٔ افزایش‌یافته",
        lines: [
          { accountId: acct.expense, debit: 2_500_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 2_500_000 },
        ],
      }),
    });
    expect(edited.version).toBe(2);

    const [stillFirst] = await occurrenceRows(id);
    const after = await manualJournal.getDraft(biz.id, stillFirst.draft_id!);
    expect(after?.lines[0].debit).toBe(1_000_000);
    expect(after?.memo).toBe("اجارهٔ ماهانهٔ دفتر");

    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 7, 30),
    });
    const rows = await occurrenceRows(id);
    const next = rows.find((row) => row.scheduled_date === iso(1404, 7, 30));
    expect(next?.status).toBe("draft");
    const nextDraft = await manualJournal.getDraft(biz.id, next!.draft_id!);
    expect(nextDraft?.lines[0].debit).toBe(2_500_000);
    expect(nextDraft?.memo).toBe("اجارهٔ افزایش‌یافته");

    const detail = await recurring.getRecurringTemplate(biz.id, id);
    expect(detail?.versions.map((version) => version.changeKind)).toEqual(["edited", "created"]);
    expect(detail?.currentVersion).toBe(2);
  });
});

describe("holds", () => {
  it("holds a locked fiscal period instead of creating or back-posting a draft", async () => {
    const year = await fiscalService.createFiscalYear(biz.id, 1404, user.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const shahrivar = periods.find((period) => period.startsOn === iso(1404, 6, 1))!;
    await fiscalService.setPeriodStatus(biz.id, shahrivar.id, "soft_closed", user.id);
    await fiscalService.setPeriodStatus(biz.id, shahrivar.id, "locked", user.id);

    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    const result = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    expect(result.failed).toBe(1);
    const [occurrence] = await occurrenceRows(id);
    expect(occurrence.status).toBe("failed");
    expect(occurrence.held_reason).toBe("fiscal_period_locked");
    expect(occurrence.draft_id).toBeNull();
    expect(await draftCount()).toBe(0);
  });

  it("holds an archived account with an actionable code and no substitution", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await db.query("UPDATE accounts SET is_active = false WHERE id = $1", [acct.expense]);

    const result = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    expect(result.failed).toBe(1);
    const [occurrence] = await occurrenceRows(id);
    expect(occurrence.status).toBe("failed");
    expect(["account_inactive", "unknown_account"]).toContain(occurrence.held_reason);
    expect(await draftCount()).toBe(0);
  });

  it("retries a held occurrence and skips one without any journal effect", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await db.query("UPDATE accounts SET is_active = false WHERE id = $1", [acct.expense]);
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    const [held] = await occurrenceRows(id);
    expect(held.status).toBe("failed");

    // Restoring the account makes the retry succeed with a real draft.
    await db.query("UPDATE accounts SET is_active = true WHERE id = $1", [acct.expense]);
    const retried = await recurring.retryOccurrence({
      businessId: biz.id,
      occurrenceId: (await db.query<{ id: string }>(
        "SELECT id FROM recurring_journal_occurrences WHERE template_id = $1",
        [id],
      )).rows[0].id,
      actorId: user.id,
    });
    expect(retried.status).toBe("draft");
    expect(await draftCount()).toBe(1);

    // A second, held occurrence can be skipped.
    await db.query("UPDATE accounts SET is_active = false WHERE id = $1", [acct.expense]);
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 7, 30),
    });
    const failed = await db.query<{ id: string }>(
      "SELECT id FROM recurring_journal_occurrences WHERE template_id = $1 AND status = 'failed'",
      [id],
    );
    await recurring.skipOccurrence({
      businessId: biz.id,
      occurrenceId: failed.rows[0].id,
      actorId: user.id,
    });
    const skipped = await db.query<{ status: string }>(
      "SELECT status FROM recurring_journal_occurrences WHERE id = $1",
      [failed.rows[0].id],
    );
    expect(skipped.rows[0].status).toBe("skipped");
    expect(await draftCount()).toBe(1);
  });
});

describe("lifecycle", () => {
  it("pauses, resumes and cancels, and never lets a cancelled template generate", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await recurring.setRecurringTemplateStatus({
      businessId: biz.id,
      templateId: id,
      actorId: user.id,
      status: "paused",
    });
    const paused = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 8, 30),
    });
    expect(paused.draftsCreated).toBe(0);

    await recurring.setRecurringTemplateStatus({
      businessId: biz.id,
      templateId: id,
      actorId: user.id,
      status: "active",
    });
    await recurring.setRecurringTemplateStatus({
      businessId: biz.id,
      templateId: id,
      actorId: user.id,
      status: "cancelled",
    });
    const cancelled = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 8, 30),
    });
    expect(cancelled.draftsCreated).toBe(0);

    await expect(
      recurring.setRecurringTemplateStatus({
        businessId: biz.id,
        templateId: id,
        actorId: user.id,
        status: "active",
      }),
    ).rejects.toMatchObject({ message: "invalid_status_transition" });
  });

  it("completes a template once its end date has passed", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input({ endDate: iso(1404, 7, 30) }),
    });
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 9, 1),
    });
    const detail = await recurring.getRecurringTemplate(biz.id, id);
    expect(detail?.status).toBe("completed");
    expect(detail?.nextOccurrenceDate).toBeNull();
    expect(detail?.occurrences).toHaveLength(2);
  });
});

describe("tenant isolation", () => {
  it("shows a business only its own templates and occurrences", async () => {
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input(),
    });
    await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });

    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    const otherId = other.rows[0].id;

    const mine = await recurring.listRecurringTemplates(biz.id);
    expect(mine).toHaveLength(1);

    const theirs = await dbLib.withTenant(otherId, () => recurring.listRecurringTemplates(otherId));
    expect(theirs).toHaveLength(0);

    const otherOccurrences = await dbLib.withTenant(otherId, async () => {
      const { rows } = await dbLib.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM recurring_journal_occurrences WHERE business_id = $1",
        [otherId],
      );
      return rows[0].n;
    });
    expect(otherOccurrences).toBe(0);
  });
});

describe("party attribution", () => {
  /** A party that belongs to a different business than `biz`. */
  async function foreignParty(): Promise<string> {
    const other = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`party-other-${randomUUID().slice(0, 8)}`],
    );
    const party = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'Foreign supplier', 'supplier') RETURNING id",
      [other.rows[0].id],
    );
    return party.rows[0].id;
  }

  it("refuses a template whose line names another business's party", async () => {
    const partyId = await foreignParty();
    const { rows: before } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM recurring_journal_templates",
    );

    await expect(
      recurring.createRecurringTemplate({
        businessId: biz.id,
        actorId: user.id,
        input: input({
          lines: [
            { accountId: acct.expense, debit: 1_000_000, credit: 0, partyId },
            { accountId: acct.cash, debit: 0, credit: 1_000_000 },
          ],
        }),
      }),
    ).rejects.toThrow("unknown_party");

    const { rows: after } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM recurring_journal_templates",
    );
    expect(after[0].n).toBe(before[0].n);
  });

  it("holds an occurrence instead of drafting it when its snapshot names another business's party", async () => {
    const own = await db.query<{ id: string }>(
      "INSERT INTO parties (business_id, name, role) VALUES ($1, 'Own supplier', 'supplier') RETURNING id",
      [biz.id],
    );
    const { id } = await recurring.createRecurringTemplate({
      businessId: biz.id,
      actorId: user.id,
      input: input({
        frequency: "yearly",
        lines: [
          { accountId: acct.expense, debit: 1_000_000, credit: 0, partyId: own.rows[0].id },
          { accountId: acct.cash, debit: 0, credit: 1_000_000 },
        ],
      }),
    });

    // Bypass the write-time check the way a restore or an older row could: put
    // the other business's party straight onto the template line.
    await db.query(
      "UPDATE recurring_journal_template_lines SET party_id = $2 WHERE template_id = $1",
      [id, await foreignParty()],
    );

    const result = await recurring.generateForTemplate({
      businessId: biz.id,
      templateId: id,
      asOfDate: iso(1404, 6, 31),
    });
    expect(result.occurrences).toEqual([
      { id: expect.any(String), scheduledDate: iso(1404, 6, 31), status: "failed" },
    ]);

    const [occurrence] = await occurrenceRows(id);
    expect(occurrence.held_reason).toBe("unknown_party");
    expect(occurrence.draft_id).toBeNull();
    expect(await draftCount()).toBe(0);
  });
});
