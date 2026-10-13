/**
 * Phase 16 scope: "Per-business chart of accounts — customisation,
 * sub-accounts, and account archival that respects existing postings."
 * `accounts.parent_id`/`is_active` have existed since Phase 1; this proves
 * the CRUD built on top of them: sub-accounts, renaming, reparenting
 * (including cycle rejection), archiving (blocked for well-known codes,
 * allowed regardless of history), and deletion (only ever for an account
 * nothing has posted to, real or drafted, and with no sub-accounts).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let testDatabaseUrl: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let accountsService: typeof import("../src/lib/accounts-service");
let auditService: typeof import("../src/lib/audit-service");
let manualJournal: typeof import("../src/lib/manual-journal-service");

const biz = { id: "" };
const acct = { cash: "", expense: "", expenseParent: "", otherExpenseParent: "", assetGroup: "" };
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
  databaseName = `pos_coa_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  testDatabaseUrl = urlFor(databaseName);
  process.env.DATABASE_URL = testDatabaseUrl;
  dbLib = await import("../src/lib/db");
  accountsService = await import("../src/lib/accounts-service");
  auditService = await import("../src/lib/audit-service");
  manualJournal = await import("../src/lib/manual-journal-service");

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
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('COA Co', $1) RETURNING id",
    [`coa-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'),
            ($1, '1120', 'Petty Cash', 'asset'),
            ($1, '5000', 'Expenses', 'expense'),
            ($1, '5600', 'Other Expenses', 'expense'),
            ($1, '5300', 'Rent', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.assetGroup = r.id;
    if (r.code === "5000") acct.expenseParent = r.id;
    if (r.code === "5600") acct.otherExpenseParent = r.id;
    if (r.code === "5300") acct.expense = r.id;
  }
  await db.query("UPDATE accounts SET parent_id = $1 WHERE id = $2", [acct.expenseParent, acct.expense]);
});

describe("createAccount", () => {
  it("adds a sub-account under an existing parent", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "5310",
      name: "Marketing",
      type: "expense",
      parentId: acct.expenseParent,
    });
    const list = await accountsService.listAccounts(biz.id);
    const created = list.find((a) => a.id === id);
    expect(created).toMatchObject({ code: "5310", name: "Marketing", type: "expense", parentId: acct.expenseParent, isActive: true });
  });

  it("rejects a duplicate code", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "1100", name: "Dup", type: "asset" }),
    ).rejects.toThrow("code_in_use");
  });

  it("rejects an unknown parent", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5320", name: "X", type: "expense", parentId: randomUUID() }),
    ).rejects.toThrow("parent_not_found");
  });

  it("rejects an empty name or invalid type", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5330", name: "  ", type: "expense" }),
    ).rejects.toThrow("name_required");
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5340", name: "X", type: "bogus" }),
    ).rejects.toThrow("invalid_type");
  });
});

describe("account levels (گروه/کل/معین/تفصیلی)", () => {
  it("assigns group to a root account and cascades kol -> moein -> tafsili down a chain", async () => {
    const { id: groupId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6000",
      name: "Root",
      type: "expense",
    });
    const { id: kolId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6100",
      name: "Kol",
      type: "expense",
      parentId: groupId,
    });
    const { id: moeinId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6110",
      name: "Moein",
      type: "expense",
      parentId: kolId,
    });
    const { id: tafsiliId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6111",
      name: "Tafsili",
      type: "expense",
      parentId: moeinId,
    });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === groupId)!.level).toBe("group");
    expect(list.find((a) => a.id === kolId)!.level).toBe("kol");
    expect(list.find((a) => a.id === moeinId)!.level).toBe("moein");
    expect(list.find((a) => a.id === tafsiliId)!.level).toBe("tafsili");
  });

  it("refuses to add a child under a تفصیلی account", async () => {
    const { id: groupId } = await accountsService.createAccount({ businessId: biz.id, code: "6200", name: "G", type: "expense" });
    const { id: kolId } = await accountsService.createAccount({ businessId: biz.id, code: "6210", name: "K", type: "expense", parentId: groupId });
    const { id: moeinId } = await accountsService.createAccount({ businessId: biz.id, code: "6211", name: "M", type: "expense", parentId: kolId });
    const { id: tafsiliId } = await accountsService.createAccount({ businessId: biz.id, code: "6212", name: "T", type: "expense", parentId: moeinId });

    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "6213", name: "TooDeep", type: "expense", parentId: tafsiliId }),
    ).rejects.toThrow("parent_too_deep");
  });

  it("reparenting cascades the new level down to every descendant", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6300", name: "A", type: "expense" });
    const { id: groupB } = await accountsService.createAccount({ businessId: biz.id, code: "6400", name: "B", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6310", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6311", name: "Moein", type: "expense", parentId: kol });

    // Move `kol` (and its descendant `moein`) under groupB's own kol level
    // by first nesting groupB one level deeper, then reparenting `kol` there —
    // pushing `kol` from kol-level to moein-level, and `moein` to tafsili-level.
    const { id: kolB } = await accountsService.createAccount({ businessId: biz.id, code: "6410", name: "KolB", type: "expense", parentId: groupB });
    await accountsService.reparentAccount(biz.id, kol, kolB);

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === kol)!.level).toBe("moein");
    expect(list.find((a) => a.id === moein)!.level).toBe("tafsili");
  });

  it("refuses a reparent that would push a descendant past تفصیلی", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6500", name: "A", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6510", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6511", name: "Moein", type: "expense", parentId: kol });
    await accountsService.createAccount({ businessId: biz.id, code: "6512", name: "Tafsili", type: "expense", parentId: moein });

    const { id: groupB } = await accountsService.createAccount({ businessId: biz.id, code: "6600", name: "B", type: "expense" });
    const { id: kolB } = await accountsService.createAccount({ businessId: biz.id, code: "6610", name: "KolB", type: "expense", parentId: groupB });
    const { id: moeinB } = await accountsService.createAccount({ businessId: biz.id, code: "6611", name: "MoeinB", type: "expense", parentId: kolB });

    // `kol`'s subtree is 3 levels deep (kol -> moein -> tafsili); reparenting
    // it under moeinB (already تفصیلی-next) would push its tafsili-level
    // grandchild past the deepest tier.
    await expect(accountsService.reparentAccount(biz.id, kol, moeinB)).rejects.toThrow("hierarchy_too_deep");
  });

  it("clearing the parent resets an account (and its descendants) back to group/kol", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6700", name: "A", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6710", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6711", name: "Moein", type: "expense", parentId: kol });

    await accountsService.reparentAccount(biz.id, kol, null);

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === kol)!.level).toBe("group");
    expect(list.find((a) => a.id === moein)!.level).toBe("kol");
  });
});

describe("account nature (normal balance & contra)", () => {
  it("stores debit-normal for asset/expense and credit-normal for liability/equity/revenue", async () => {
    const asset = await accountsService.createAccount({ businessId: biz.id, code: "6800", name: "Asset", type: "asset" });
    const liability = await accountsService.createAccount({ businessId: biz.id, code: "6801", name: "Liability", type: "liability" });
    const equity = await accountsService.createAccount({ businessId: biz.id, code: "6802", name: "Equity", type: "equity" });
    const revenue = await accountsService.createAccount({ businessId: biz.id, code: "6803", name: "Revenue", type: "revenue" });
    const expense = await accountsService.createAccount({ businessId: biz.id, code: "6804", name: "Expense", type: "expense" });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === asset.id)!.normalBalance).toBe("debit");
    expect(list.find((a) => a.id === liability.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === equity.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === revenue.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === expense.id)!.normalBalance).toBe("debit");
  });

  it("persists an explicit isContra flag, defaulting to false", async () => {
    const contra = await accountsService.createAccount({ businessId: biz.id, code: "6900", name: "Returns", type: "revenue", isContra: true });
    const normal = await accountsService.createAccount({ businessId: biz.id, code: "6901", name: "Sales", type: "revenue" });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === contra.id)!.isContra).toBe(true);
    expect(list.find((a) => a.id === normal.id)!.isContra).toBe(false);
  });
});

describe("renameAccount", () => {
  it("renames without touching code or type", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent expense (renamed)");
    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.name).toBe("Rent expense (renamed)");
    expect(row.code).toBe("5300");
  });

  it("404s renaming an account that doesn't exist", async () => {
    await expect(accountsService.renameAccount(biz.id, randomUUID(), "X")).rejects.toThrow("account_not_found");
  });
});

describe("reparentAccount", () => {
  it("moves an account under a new parent of the same type", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.otherExpenseParent);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.parentId).toBe(acct.otherExpenseParent);
  });

  it("clears the parent when given null", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, null);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.parentId).toBeNull();
  });

  it("rejects making an account its own parent", async () => {
    await expect(accountsService.reparentAccount(biz.id, acct.expense, acct.expense)).rejects.toThrow("parent_cycle");
  });

  it("rejects a cycle through a chain of descendants", async () => {
    // expenseParent (5000) is currently the parent of expense (5300).
    // Making expenseParent a child of expense would create a cycle.
    await expect(accountsService.reparentAccount(biz.id, acct.expenseParent, acct.expense)).rejects.toThrow("parent_cycle");
  });
});

describe("setAccountActive (archive/restore)", () => {
  it("archives and restores an ordinary account, keeping it in the list either way", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false);
    let list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.isActive).toBe(false);

    await accountsService.setAccountActive(biz.id, acct.expense, true);
    list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.isActive).toBe(true);
  });

  it("archiving does not remove or hide the account's history", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 50_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 50_000 },
      ],
      createdBy: user.id,
    });
    await manualJournal.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });

    await accountsService.setAccountActive(biz.id, acct.expense, false);

    const { rows } = await db.query("SELECT count(*)::int AS n FROM journal_lines WHERE account_id = $1", [acct.expense]);
    expect(rows[0].n).toBe(1);

    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.isActive).toBe(false);
    expect(row.hasPostings).toBe(true);
  });

  it("refuses to archive a well-known account", async () => {
    await expect(accountsService.setAccountActive(biz.id, acct.cash, false)).rejects.toThrow("well_known_account");
  });

  it("an archived account can no longer be drafted against", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false);
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Rent",
        lines: [
          { accountId: acct.expense, debit: 10_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 10_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("unknown_account");
  });
});

describe("deleteAccount", () => {
  it("deletes an account that was never posted to", async () => {
    const { id } = await accountsService.createAccount({ businessId: biz.id, code: "5320", name: "Unused", type: "expense" });
    await accountsService.deleteAccount(biz.id, id);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)).toBeUndefined();
  });

  it("refuses to delete an account with real postings", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 50_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 50_000 },
      ],
      createdBy: user.id,
    });
    await manualJournal.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });

    await expect(accountsService.deleteAccount(biz.id, acct.expense)).rejects.toThrow("account_has_postings");
  });

  it("refuses to delete an account with a pending draft posting", async () => {
    await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 10_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 10_000 },
      ],
      createdBy: user.id,
    });

    await expect(accountsService.deleteAccount(biz.id, acct.expense)).rejects.toThrow("account_has_draft_postings");
  });

  it("refuses to delete an account that still has sub-accounts", async () => {
    await expect(accountsService.deleteAccount(biz.id, acct.expenseParent)).rejects.toThrow("account_has_children");
  });

  it("refuses to delete a well-known account", async () => {
    await expect(accountsService.deleteAccount(biz.id, acct.cash)).rejects.toThrow("well_known_account");
  });
});

describe("account audit trail (issue #160 §7.5)", () => {
  it("records who renamed an account, and its before/after name", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent (renamed)", user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.renamed");
    expect(entry.actorId).toBe(user.id);
    expect(entry.payload).toEqual({ before: "Rent", after: "Rent (renamed)" });
  });

  it("records nothing when a rename is a no-op (same name)", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent", user.id);
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries).toEqual([]);
  });

  it("records a reparent with before/after parent labels resolved live", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.otherExpenseParent, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.reparented");
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBe("5600 — Other Expenses");
  });

  it("records a reparent to no parent (top-level) with a null after-label", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, null, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.reparented");
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBeNull();
  });

  it("records nothing when a reparent is a no-op (same parent)", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.expenseParent, user.id);
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries).toEqual([]);
  });

  it("records an archive and a later reactivate as two distinct actions", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.setAccountActive(biz.id, acct.expense, true, user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries.map((e) => e.action)).toEqual(["account.reactivated", "account.archived"]);
  });

  it("the account's own current code/name resolve as entityName, even after a later rename", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.renameAccount(biz.id, acct.expense, "Rent v2", user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    const archiveEntry = entries.find((e) => e.action === "account.archived")!;
    expect(archiveEntry.entityName).toBe("5300 — Rent v2");
  });
});

/**
 * The bugs a chart-of-accounts screen actually hits: an id that is not a uuid,
 * a Persian-digit code, a half-applied combined edit, and a repeated archive.
 */
describe("chart-of-accounts hardening", () => {
  it("404s (never 500s) for an id that is not a uuid", async () => {
    // `WHERE id = $1` against a uuid column raises `invalid input syntax for
    // type uuid` for anything else, which used to surface as a 500 and the
    // generic «خطای غیرمنتظره» — see uuid.ts.
    await expect(accountsService.renameAccount(biz.id, "not-a-uuid", "X")).rejects.toThrow("account_not_found");
    await expect(accountsService.deleteAccount(biz.id, "not-a-uuid")).rejects.toThrow("account_not_found");
    await expect(accountsService.setAccountActive(biz.id, "not-a-uuid", false)).rejects.toThrow("account_not_found");
  });

  it("never touches another business's account", async () => {
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await expect(accountsService.renameAccount(otherBiz.rows[0].id, acct.expense, "Hijacked")).rejects.toThrow(
      "account_not_found",
    );
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });

  it("stores a Persian-digit code as ASCII, so well-known lookups still find it", async () => {
    // Auto-posting looks accounts up by code (WELL_KNOWN_CODES). A code saved
    // as «۶۱۰۰» is a different string from "6100" and nothing would find it.
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "۶۱۰۰",
      name: "Persian digits",
      type: "expense",
    });
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)!.code).toBe("6100");
  });

  it("treats a Persian-digit duplicate as the duplicate it is", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "۵۳۰۰", name: "Dup", type: "expense" }),
    ).rejects.toThrow("code_in_use");
  });

  it("applies a rename and a reparent atomically — a rejected move rolls the rename back", async () => {
    // The bug: the route ran rename, then reparent. A move the hierarchy rules
    // refuse left the account renamed and the caller holding an error.
    await expect(
      accountsService.updateAccount({
        businessId: biz.id,
        id: acct.expense,
        name: "Renamed but not moved",
        parentId: acct.expense, // its own parent — always rejected
        reparent: true,
      }),
    ).rejects.toThrow("parent_cycle");

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });

  it("applies a combined rename + reparent in one call", async () => {
    await accountsService.updateAccount({
      businessId: biz.id,
      id: acct.expense,
      actorId: user.id,
      name: "Rent & moved",
      parentId: null,
      reparent: true,
    });
    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.name).toBe("Rent & moved");
    expect(row.parentId).toBeNull();

    const actions = (await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense })).map(
      (e) => e.action,
    );
    expect(actions).toContain("account.renamed");
    expect(actions).toContain("account.reparented");
  });

  it("records nothing when an archive is a no-op (already archived)", async () => {
    // Rename and reparent have always skipped their no-ops; archiving wrote a
    // fresh row every time, so a double-click invented history.
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries.filter((e) => e.action === "account.archived")).toHaveLength(1);
  });

  it("writes the audit row in the same transaction as the change", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Audited rename", user.id);
    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    const { rows } = await db.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [acct.expense]);
    expect(rows[0].name).toBe("Audited rename");
    expect(entry.payload).toEqual({ before: "Rent", after: "Audited rename" });
  });

  it("rejects a blank rename without writing anything", async () => {
    await expect(accountsService.renameAccount(biz.id, acct.expense, "   ")).rejects.toThrow("name_required");
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });
});

describe("the audit trail survives rows a settings writer logged", () => {
  // `audit_log.entity_id` is text, and the settings writers do not put a uuid
  // in it (`settings.mfa_policy.update` logs 'mfa.policy',
  // `settings.business.update` logs 'business'). The trail's joins used to
  // cast the column bare, so ONE such row made listAuditLog — and with it the
  // whole audit tab — throw `invalid input syntax for type uuid` for every
  // reader of that business, forever.
  it("lists the trail beside a row whose entity_id is text, not a uuid", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent (renamed)", user.id);
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'settings.business.update', 'settings', 'business', '{"businessName":"Renamed Co"}')`,
      [biz.id, user.id],
    );

    const entries = await auditService.listAuditLog(biz.id, {});
    expect(entries.map((e) => e.action)).toContain("settings.business.update");
    expect(entries.map((e) => e.action)).toContain("account.renamed");
    // And the entity filter the audit tab's chip sends still narrows to it.
    const [settingsEntry] = await auditService.listAuditLog(biz.id, { entity: "settings" });
    expect(settingsEntry.action).toBe("settings.business.update");
  });

  it("still resolves an account row's live labels once a non-uuid row exists", async () => {
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'settings.mfa_policy.update', 'settings', 'mfa.policy', '{"requireForManagers":true}')`,
      [biz.id, user.id],
    );
    await accountsService.reparentAccount(biz.id, acct.expense, acct.otherExpenseParent, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBe("5600 — Other Expenses");
  });
});

/**
 * Issue #824 — chart-of-accounts hardening tests.
 */
describe("issue #824: parent/child type consistency (§2)", () => {
  it("rejects creating a child whose type differs from its parent", async () => {
    await expect(
      accountsService.createAccount({
        businessId: biz.id,
        code: "5399",
        name: "Type mismatch",
        type: "asset",
        parentId: acct.expenseParent, // expense group
      }),
    ).rejects.toThrow("parent_type_mismatch");
  });

  it("allows creating a child whose type matches its parent", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "5398",
      name: "Type match",
      type: "expense",
      parentId: acct.expenseParent,
    });
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)!.type).toBe("expense");
  });

  it("rejects reparenting a subtree to a different-type branch", async () => {
    // Create an expense kol+moein chain then try to move the kol under the
    // asset group (cash).
    const { id: kol } = await accountsService.createAccount({
      businessId: biz.id,
      code: "7100",
      name: "K1",
      type: "expense",
      parentId: acct.expenseParent,
    });
    await accountsService.createAccount({
      businessId: biz.id,
      code: "7110",
      name: "M1",
      type: "expense",
      parentId: kol,
    });
    await expect(accountsService.reparentAccount(biz.id, kol, acct.cash)).rejects.toThrow("parent_type_mismatch");
  });
});

describe("issue #824: archived-parent invariants (§3)", () => {
  it("rejects creating a child under an archived parent", async () => {
    // Archive a leaf account (no children)
    const { id: leaf } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8000",
      name: "ArchiveMe",
      type: "expense",
    });
    await accountsService.setAccountActive(biz.id, leaf, false);
    await expect(
      accountsService.createAccount({
        businessId: biz.id,
        code: "8010",
        name: "Child of archived",
        type: "expense",
        parentId: leaf,
      }),
    ).rejects.toThrow("parent_archived");
  });

  it("rejects reparenting under an archived parent", async () => {
    const { id: g } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8100",
      name: "GA",
      type: "expense",
    });
    const { id: child } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8110",
      name: "ChildA",
      type: "expense",
    });
    await accountsService.setAccountActive(biz.id, g, false);
    await expect(accountsService.reparentAccount(biz.id, child, g)).rejects.toThrow("parent_archived");
  });

  it("rejects archiving a parent that still has active descendants", async () => {
    const { id: parent } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8200",
      name: "Parent",
      type: "expense",
    });
    await accountsService.createAccount({
      businessId: biz.id,
      code: "8210",
      name: "Child",
      type: "expense",
      parentId: parent,
    });
    await expect(accountsService.setAccountActive(biz.id, parent, false)).rejects.toThrow(
      "parent_has_active_children",
    );
  });

  it("allows archiving once descendants are archived first", async () => {
    const { id: parent } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8300",
      name: "Parent2",
      type: "expense",
    });
    const { id: child } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8310",
      name: "Child2",
      type: "expense",
      parentId: parent,
    });
    await accountsService.setAccountActive(biz.id, child, false);
    await accountsService.setAccountActive(biz.id, parent, false);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === parent)!.isActive).toBe(false);
  });
});

describe("issue #824: management metadata includes draft postings (§4)", () => {
  it("exposes hasDraftPostings so the UI can mirror service delete eligibility", async () => {
    const { id: unused } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8400",
      name: "Unused",
      type: "expense",
    });
    let list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === unused)!.hasDraftPostings).toBe(false);

    await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Draft",
      lines: [
        { accountId: unused, debit: 1000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 1000 },
      ],
      createdBy: user.id,
    });
    list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === unused)!.hasDraftPostings).toBe(true);
  });
});

describe("issue #824: creation and hard-deletion audit (§5)", () => {
  it("records account.created on create, including snapshot fields", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8500",
      name: "Created",
      type: "expense",
      actorId: user.id,
    });
    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: id });
    expect(entry.action).toBe("account.created");
    expect(entry.actorId).toBe(user.id);
    expect((entry.payload as Record<string, unknown>).code).toBe("8500");
    expect((entry.payload as Record<string, unknown>).name).toBe("Created");
    expect((entry.payload as Record<string, unknown>).type).toBe("expense");
    expect((entry.payload as Record<string, unknown>).level).toBe("group");
  });

  it("records account.deleted with a snapshot and the audit row survives", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8600",
      name: "Will delete",
      type: "expense",
      actorId: user.id,
    });
    await accountsService.deleteAccount(biz.id, id, user.id);
    // The account row is gone, but the audit rows (created + deleted) remain.
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: id });
    expect(entries.map((e) => e.action)).toContain("account.deleted");
    const deleted = entries.find((e) => e.action === "account.deleted")!;
    expect((deleted.payload as Record<string, unknown>).code).toBe("8600");
    expect((deleted.payload as Record<string, unknown>).name).toBe("Will delete");
    const { rows } = await db.query("SELECT count(*)::int AS n FROM accounts WHERE id = $1", [id]);
    expect(rows[0].n).toBe(0);
  });

  it("writes no audit row when creation fails validation", async () => {
    await expect(
      accountsService.createAccount({
        businessId: biz.id,
        code: "8700",
        name: "", // invalid
        type: "expense",
        actorId: user.id,
      }),
    ).rejects.toThrow();
    const entries = await auditService.listAuditLog(biz.id, { action: "account.created" });
    expect(entries.find((e) => (e.payload as Record<string, unknown>)?.code === "8700")).toBeUndefined();
  });
});

describe("issue #824: isContra editing via PATCH (§6)", () => {
  it("updates isContra and writes an audit entry", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8800",
      name: "Contra target",
      type: "revenue",
      isContra: false,
      actorId: user.id,
    });
    await accountsService.updateAccount({
      businessId: biz.id,
      id,
      actorId: user.id,
      isContra: true,
    });
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)!.isContra).toBe(true);
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: id });
    expect(entries.map((e) => e.action)).toContain("account.contra_changed");
  });

  it("refuses flipping isContra on a well-known account (sales returns is already contra; cash must stay non-contra)", async () => {
    await expect(
      accountsService.updateAccount({
        businessId: biz.id,
        id: acct.cash,
        isContra: true,
      }),
    ).rejects.toThrow("well_known_account");
  });
});

describe("issue #824: POST isContra validation (§10)", () => {
  it("rejects a non-boolean isContra", async () => {
    // Passing the string "false" would previously coerce to true via Boolean(...).
    await expect(
      accountsService.createAccount({
        businessId: biz.id,
        code: "8900",
        name: "Bad contra",
        type: "expense",
        // @ts-expect-error -- deliberate bad type
        isContra: "false",
      }),
    ).rejects.toThrow("bad_request");
  });
});

describe("issue #824: concurrency — concurrent opposite reparents cannot create a cycle (§1)", () => {
  it("serializes opposite reparents under the advisory lock", async () => {
    // Two separate group-level accounts; we try concurrently to move A under
    // B and B under A. Without the lock this is the classic cycle race: both
    // read pre-mutation state, both pass assertNoCycle, both commit a cycle.
    // With pg_advisory_xact_lock held per business, at most one reparent runs
    // at a time; the second must then observe the first's result and either
    // succeed or fail — but the end state must have no cycle.
    const { id: a } = await accountsService.createAccount({
      businessId: biz.id,
      code: "9100",
      name: "A",
      type: "expense",
    });
    const { id: b } = await accountsService.createAccount({
      businessId: biz.id,
      code: "9200",
      name: "B",
      type: "expense",
    });
    const results = await Promise.allSettled([
      accountsService.reparentAccount(biz.id, a, b),
      accountsService.reparentAccount(biz.id, b, a),
    ]);
    // The lock serializes them: one succeeds, the other must fail either
    // parent_cycle (seeing A already under B when it tries to put B under A)
    // or hierarchy_too_deep — but neither a silent success nor a DB cycle.
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain("fulfilled");
    // Walk the parent chain from every root to confirm no cycle exists — if
    // any chain revisits a node, the invariant is broken.
    const { rows } = await db.query<{ id: string; parent_id: string | null }>(
      "SELECT id, parent_id FROM accounts WHERE business_id = $1",
      [biz.id],
    );
    const byId = new Map(rows.map((r) => [r.id, r.parent_id]));
    for (const row of rows) {
      const seen = new Set<string>();
      let current: string | null = row.id;
      let guard = 0;
      while (current && guard < 100) {
        if (seen.has(current)) {
          throw new Error(`Cycle detected starting from ${row.id}`);
        }
        seen.add(current);
        current = byId.get(current) ?? null;
        guard++;
      }
    }
  });
});

/* ============================================================================
 * Issue #824 review — deterministic regressions.
 *
 * The earlier suite ran the opposite reparents through `Promise.allSettled`,
 * which does not force an interleaving: with the lock removed the two calls
 * could still happen to run one-after-the-other and the test would pass while
 * the invariant was absent. These tests use an explicit barrier (pre-acquiring
 * the same advisory lock on a second connection and proving both writers are
 * *waiting* on it) so that removing `lockChartOfAccounts` makes them fail, not
 * merely make them lucky.
 * ==========================================================================*/

/** The advisory-lock key `lockChartOfAccounts` derives, reproduced here so the
 *  test's barrier presses on the same lock the service takes. */
const COA_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('chart-of-accounts:' || $1, 0))`;

/** How many sessions are currently blocked waiting for *any* advisory lock. */
async function advisoryWaiters(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted`,
  );
  return Number(rows[0].n);
}

/** Poll until at least `expected` sessions wait on an advisory lock, or throw. */
async function waitForAdvisoryWaiters(expected: number, budgetMs = 4000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await advisoryWaiters();
    if (last >= expected) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  return last;
}

describe("issue #824 §1: deterministic lock contention (barrier, not timing)", () => {
  it("holds both opposite reparents on the advisory lock, then lets exactly one win", async () => {
    const { id: a } = await accountsService.createAccount({
      businessId: biz.id, code: "9300", name: "Barrier A", type: "expense",
    });
    const { id: b } = await accountsService.createAccount({
      businessId: biz.id, code: "9400", name: "Barrier B", type: "expense",
    });

    // Barrier: a separate connection holds the very lock the service must take.
    const holder = new Client({ connectionString: testDatabaseUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(COA_LOCK_SQL, [biz.id]);

      let settled = 0;
      const both = Promise.allSettled([
        accountsService.reparentAccount(biz.id, a, b),
        accountsService.reparentAccount(biz.id, b, a),
      ]).then((r) => {
        settled = r.length;
        return r;
      });

      // Deterministic detector: with the protection in place, both writers are
      // parked on the advisory lock. Without it neither would wait at all, so
      // `waiters` stays 0 and this assertion fails the test — which is the
      // whole point (the old Promise.allSettled version could not tell).
      const waiters = await waitForAdvisoryWaiters(2);
      expect(waiters).toBeGreaterThanOrEqual(2);
      expect(settled).toBe(0); // still blocked: nothing committed while we held it

      await holder.query("COMMIT"); // release; the two writers now serialize
      const results = await both;

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // The loser must be refused by the hierarchy rule, not by a crash.
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
        /parent_cycle|hierarchy_too_deep/,
      );

      const { rows } = await db.query<{ id: string; parent_id: string | null }>(
        "SELECT id, parent_id FROM accounts WHERE business_id = $1",
        [biz.id],
      );
      const byId = new Map(rows.map((r) => [r.id, r.parent_id]));
      for (const row of rows) {
        const seen = new Set<string>();
        let current: string | null = row.id;
        while (current) {
          expect(seen.has(current)).toBe(false); // no node revisited ⇒ no cycle
          seen.add(current);
          current = byId.get(current) ?? null;
        }
      }
    } finally {
      await holder.end().catch(() => {});
    }
  });

  it("refuses a create that races an archive of its chosen parent", async () => {
    const { id: parent } = await accountsService.createAccount({
      businessId: biz.id, code: "9500", name: "Racy parent", type: "expense",
    });
    const results = await Promise.allSettled([
      accountsService.setAccountActive(biz.id, parent, false),
      accountsService.createAccount({
        businessId: biz.id, code: "9510", name: "Racy child", type: "expense", parentId: parent,
      }),
    ]);
    // Archive-then-create must be refused (parent_archived); create-then-archive
    // is allowed. Either way the impossible state is absent.
    const { rows } = await db.query<{ is_active: boolean; n: string }>(
      `SELECT p.is_active, (SELECT count(*)::text FROM accounts c WHERE c.parent_id = p.id) AS n
         FROM accounts p WHERE p.id = $1`,
      [parent],
    );
    const parentArchived = rows[0].is_active === false;
    const hasChild = Number(rows[0].n) > 0;
    expect(parentArchived && hasChild).toBe(false);
    // At least one of the two operations must have taken effect.
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  });
});

describe("issue #824 review §1: restore integrity (archived ancestors)", () => {
  it("refuses restoring a child whose parent is still archived, and rolls the audit back", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "9600", name: "Restore parent", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "9610", name: "Restore child", type: "expense", parentId: p,
    });

    await accountsService.setAccountActive(biz.id, c, false); // archive child
    await accountsService.setAccountActive(biz.id, p, false); // archive parent
    const before = await auditService.listAuditLog(biz.id, {});

    await expect(accountsService.setAccountActive(biz.id, c, true)).rejects.toThrow("ancestor_archived");

    // The refusal must be complete: the row stays archived and no audit row
    // claims a reactivation that did not happen.
    const { rows } = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM accounts WHERE id = $1",
      [c],
    );
    expect(rows[0].is_active).toBe(false);
    const after = await auditService.listAuditLog(biz.id, {});
    expect(after.filter((e) => e.action === "account.reactivated")).toHaveLength(
      before.filter((e) => e.action === "account.reactivated").length,
    );
  });

  it("refuses restoring a grandchild while a mid-level ancestor is archived", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "9700", name: "GP", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "9710", name: "Mid", type: "expense", parentId: p,
    });
    const { id: g } = await accountsService.createAccount({
      businessId: biz.id, code: "9720", name: "Leaf", type: "expense", parentId: c,
    });
    await accountsService.setAccountActive(biz.id, g, false);
    await accountsService.setAccountActive(biz.id, c, false);
    // p stays active; restoring g is still blocked because its direct parent c is archived.
    await expect(accountsService.setAccountActive(biz.id, g, true)).rejects.toThrow("ancestor_archived");
  });

  it("allows restoring a parent normally, then its children in order", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "9800", name: "OK parent", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "9810", name: "OK child", type: "expense", parentId: p,
    });
    await accountsService.setAccountActive(biz.id, c, false);
    await accountsService.setAccountActive(biz.id, p, false);
    await accountsService.setAccountActive(biz.id, p, true); // parent first: fine
    await accountsService.setAccountActive(biz.id, c, true); // then the child: fine
    const { rows } = await db.query<{ is_active: boolean }>(
      "SELECT is_active FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY code",
      [[p, c]],
    );
    expect(rows.map((r) => r.is_active)).toEqual([true, true]);
  });

  it("validates the effective parent on a combined reparent + reactivate PATCH", async () => {
    const { id: archivedDest } = await accountsService.createAccount({
      businessId: biz.id, code: "9900", name: "Archived dest", type: "expense",
    });
    const { id: liveDest } = await accountsService.createAccount({
      businessId: biz.id, code: "9910", name: "Live dest", type: "expense",
    });
    const { id: child } = await accountsService.createAccount({
      businessId: biz.id, code: "9920", name: "Combined child", type: "expense",
    });
    await accountsService.setAccountActive(biz.id, archivedDest, false);
    await accountsService.setAccountActive(biz.id, child, false);

    // Moving under an archived parent is refused by the reparent rule…
    await expect(
      accountsService.updateAccount({
        businessId: biz.id, id: child, parentId: archivedDest, reparent: true, isActive: true,
      }),
    ).rejects.toThrow("parent_archived");

    // …and nothing partially applied: still archived, still parentless.
    const midway = await db.query<{ is_active: boolean; parent_id: string | null }>(
      "SELECT is_active, parent_id FROM accounts WHERE id = $1",
      [child],
    );
    expect(midway.rows[0]).toMatchObject({ is_active: false, parent_id: null });

    // The same combined edit against a live destination is allowed and atomic.
    await accountsService.updateAccount({
      businessId: biz.id, id: child, parentId: liveDest, reparent: true, isActive: true,
    });
    const done = await db.query<{ is_active: boolean; parent_id: string | null }>(
      "SELECT is_active, parent_id FROM accounts WHERE id = $1",
      [child],
    );
    expect(done.rows[0]).toMatchObject({ is_active: true, parent_id: liveDest });
  });

  it("refuses reactivating an account whose parent is archived, even when the move is to the same archived parent", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "9930", name: "Same archived", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "9940", name: "Same child", type: "expense", parentId: p,
    });
    await accountsService.setAccountActive(biz.id, c, false);
    await accountsService.setAccountActive(biz.id, p, false);
    await expect(
      accountsService.updateAccount({ businessId: biz.id, id: c, parentId: p, reparent: true, isActive: true }),
    ).rejects.toThrow("ancestor_archived");
  });
});

describe("issue #824 review §2: descendant traversal below archived intermediates", () => {
  it("detects an active grandchild hidden under an archived mid-level node", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "8100", name: "Trav P", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "8110", name: "Trav C", type: "expense", parentId: p,
    });
    const { id: g } = await accountsService.createAccount({
      businessId: biz.id, code: "8120", name: "Trav G", type: "expense", parentId: c,
    });

    // Archive the leaf first so the middle node can be archived; the leaf is
    // then restored while the middle node stays archived — the exact shape the
    // old is_active-filtered recursion could not see.
    await accountsService.setAccountActive(biz.id, g, false);
    await accountsService.setAccountActive(biz.id, c, false);
    await db.query("UPDATE accounts SET is_active = true WHERE id = $1", [g]); // corrupt-ish but legal state

    await expect(accountsService.setAccountActive(biz.id, p, false)).rejects.toThrow(
      "parent_has_active_children",
    );
    const { rows } = await db.query<{ is_active: boolean }>("SELECT is_active FROM accounts WHERE id = $1", [p]);
    expect(rows[0].is_active).toBe(true); // refusal rolled back
  });

  it("terminates safely on a pre-existing cycle and does not rewrite the historical rows", async () => {
    const { id: x } = await accountsService.createAccount({
      businessId: biz.id, code: "8200", name: "Cycle X", type: "expense",
    });
    const { id: y } = await accountsService.createAccount({
      businessId: biz.id, code: "8210", name: "Cycle Y", type: "expense",
    });
    const { id: z } = await accountsService.createAccount({
      businessId: biz.id, code: "8220", name: "Cycle Z", type: "expense", parentId: x,
    });
    // Force a corrupt 3-cycle directly (no service path can create one).
    await db.query("UPDATE accounts SET parent_id = $1 WHERE id = $2", [y, x]);
    await db.query("UPDATE accounts SET parent_id = $1 WHERE id = $2", [x, y]);

    // Archiving one member walks descendants (which now loops through the
    // cycle); it must terminate with a rule error rather than hang or 500.
    const started = Date.now();
    await expect(accountsService.setAccountActive(biz.id, x, false)).rejects.toThrow(
      /parent_has_active_children|parent_cycle|hierarchy_too_deep|ancestor_archived/,
    );
    expect(Date.now() - started).toBeLessThan(5000);

    // Defence only: the corrupt rows are left exactly as they were. We never
    // "repair" historical data as a side effect of a refused mutation.
    const { rows } = await db.query<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM accounts WHERE id = ANY($1::uuid[])`,
      [[x, y, z]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.parent_id]));
    expect(byId.get(x)).toBe(y); // x ↔ y stay mutually parented
    expect(byId.get(y)).toBe(x);
    expect(byId.get(z)).toBe(x); // and the innocent bystander is untouched
  });

  it("keeps the cycle guard on the type walk too (a cyclic subtree moves without hanging)", async () => {
    const { id: a } = await accountsService.createAccount({
      businessId: biz.id, code: "8300", name: "Type cycle A", type: "expense",
    });
    const { id: b } = await accountsService.createAccount({
      businessId: biz.id, code: "8310", name: "Type cycle B", type: "expense", parentId: a,
    });
    const { id: dest } = await accountsService.createAccount({
      businessId: biz.id, code: "8320", name: "Type dest", type: "expense",
    });
    await db.query("UPDATE accounts SET parent_id = $1 WHERE id = $2", [b, a]); // a under b ⇒ a↔b cycle

    // The reparent itself is legitimate — it *breaks* the old cycle (a leaves
    // the loop for `dest`). What this regression proves is that the subtree
    // type walk visits `a → b → a → …` and terminates instead of looping
    // forever: `assertNoCycle` looks *upward* from the destination and cannot
    // see this shape, so only the descendant traversal's seen-set saves it.
    const started = Date.now();
    await accountsService.reparentAccount(biz.id, a, dest);
    expect(Date.now() - started).toBeLessThan(5000);

    const { rows } = await db.query<{ id: string; parent_id: string | null }>(
      "SELECT id, parent_id FROM accounts WHERE id = ANY($1::uuid[])",
      [[a, b, dest]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.parent_id]));
    expect(byId.get(a)).toBe(dest);
    expect(byId.get(b)).toBe(a); // b kept its parent (a) — b's old loop is gone
  });
});

describe("issue #824 review §2: mismatched descendant type on reparent", () => {
  it("refuses moving a subtree that contains a different-type descendant", async () => {
    const { id: assetRoot } = await accountsService.createAccount({
      businessId: biz.id, code: "8400", name: "Mixed root", type: "asset",
    });
    // Raw insert: the service would refuse this child, which is exactly why the
    // invariant is defence-in-depth against rows that predate the rule.
    await db.query(
      `INSERT INTO accounts (business_id, code, name, type, parent_id) VALUES ($1, '8410', 'Wrong type', 'expense', $2)`,
      [biz.id, assetRoot],
    );
    const { id: assetParent } = await accountsService.createAccount({
      businessId: biz.id, code: "8420", name: "Asset branch", type: "asset",
    });
    await expect(
      accountsService.reparentAccount(biz.id, assetRoot, assetParent),
    ).rejects.toThrow("parent_type_mismatch");
    // Atomic: the root has not moved.
    const { rows } = await db.query<{ parent_id: string | null }>(
      "SELECT parent_id FROM accounts WHERE id = $1",
      [assetRoot],
    );
    expect(rows[0].parent_id).toBeNull();
  });
});

describe("issue #824 review §7: cross-operation contention", () => {
  it("never leaves an archived parent with an active child, whatever the order", async () => {
    const { id: p } = await accountsService.createAccount({
      businessId: biz.id, code: "8500", name: "Cx parent", type: "expense",
    });
    const { id: c } = await accountsService.createAccount({
      businessId: biz.id, code: "8510", name: "Cx child", type: "expense", parentId: p,
    });
    await Promise.allSettled([
      accountsService.setAccountActive(biz.id, p, false),
      accountsService.setAccountActive(biz.id, c, false),
    ]);
    const { rows } = await db.query<{ is_active: boolean; parent_active: boolean }>(
      `SELECT c.is_active, p.is_active AS parent_active
         FROM accounts c JOIN accounts p ON p.id = c.parent_id
        WHERE c.id = $1`,
      [c],
    );
    for (const r of rows) {
      expect(r.is_active && !r.parent_active).toBe(false);
    }
  });

  it("keeps history visible after archive (postings untouched)", async () => {
    const { id: acc } = await accountsService.createAccount({
      businessId: biz.id, code: "8600", name: "History acct", type: "expense",
    });
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, memo, entry_date, source_type, created_by)
       VALUES ($1, 'x', CURRENT_DATE, 'manual', $2) RETURNING id`,
      [biz.id, user.id],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, 100, 0)`,
      [entry.rows[0].id, acc],
    );
    await accountsService.setAccountActive(biz.id, acc, false);
    const { rows } = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM journal_lines WHERE account_id = $1",
      [acc],
    );
    expect(rows[0].n).toBe("1");
    // Archived accounts stay in the full listing (Holoo export default).
    const all = await accountsService.listAccounts(biz.id);
    expect(all.find((a) => a.id === acc)?.isActive).toBe(false);
  });
});

/* ============================================================================
 * Issue #824 review §7 — tenant isolation through a real, non-superuser role.
 *
 * The `pos` role this suite otherwise connects as is a SUPERUSER, and a
 * superuser bypasses every RLS policy — so any "another business's account"
 * assertion made on that connection proves only that the service added a WHERE
 * clause, never that the database would stop a leak. This block creates a
 * NOSUPERUSER/NOBYPASSRLS role, repoints the shared pool at it, and repeats the
 * cross-tenant checks with RLS genuinely in force.
 * ==========================================================================*/

describe("issue #824 review §7: RLS isolation under a non-superuser runtime role", () => {
  const roleName = `coa_app_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let appUrl = "";
  let otherBizId = "";
  let otherAccountId = "";

  beforeAll(async () => {
    const { createAppRole } = await import("../scripts/create-app-role");
    await createAppRole({
      databaseUrl: testDatabaseUrl,
      roleName,
      password: "test-password",
      quiet: true,
    });
    const u = new URL(testDatabaseUrl);
    u.username = roleName;
    u.password = "test-password";
    appUrl = u.toString();
  }, 60_000);

  afterAll(async () => {
    // `DROP OWNED` only reaches objects in the *current* database, and the
    // role's grants live in the test database — so revoke there first, then
    // drop the (now dependency-free) role from the maintenance connection.
    const inTestDb = new Client({ connectionString: testDatabaseUrl });
    await inTestDb.connect();
    try {
      await inTestDb.query(`DROP OWNED BY "${roleName}" CASCADE`);
    } finally {
      await inTestDb.end();
    }
    const maintenance = new Client({ connectionString: maintenanceUrl() });
    await maintenance.connect();
    try {
      await maintenance.query(`DROP ROLE IF EXISTS "${roleName}"`);
    } finally {
      await maintenance.end();
    }
  });

  /** Swap the shared pool onto `url` (the pool is cached on globalThis). */
  async function useDatabaseUrl(url: string) {
    await dbLib.closeDatabasePool();
    process.env.DATABASE_URL = url;
  }

  beforeEach(async () => {
    // A second tenant, created with the privileged connection, as provisioning
    // would.
    const row = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    otherBizId = row.rows[0].id;
    const acc = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type) VALUES ($1, '7100', 'Their account', 'asset') RETURNING id`,
      [otherBizId],
    );
    otherAccountId = acc.rows[0].id;
    await useDatabaseUrl(appUrl);
  }, 30_000);

  afterEach(async () => {
    await useDatabaseUrl(testDatabaseUrl);
  }, 30_000);

  it("the runtime pool really is NOSUPERUSER / NOBYPASSRLS", async () => {
    const { rows } = await dbLib.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user AS rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolname: roleName, rolsuper: false, rolbypassrls: false });
  });

  it("cannot read or mutate another business's account, even by id", async () => {
    const list = await dbLib.withTenant(biz.id, () =>
      accountsService.listAccounts(biz.id, { all: true }),
    );
    expect(list.some((a) => a.id === otherAccountId)).toBe(false);

    // Addressed directly by id, still refused — and by its own error code, so
    // nothing accidentally reads the row and reports a validation failure.
    await expect(
      dbLib.withTenant(biz.id, () =>
        accountsService.updateAccount({
          businessId: biz.id,
          id: otherAccountId,
          name: "hijacked",
          actorId: user.id,
        }),
      ),
    ).rejects.toThrow(/account_not_found/);

    await expect(
      dbLib.withTenant(biz.id, () => accountsService.deleteAccount(biz.id, otherAccountId, user.id)),
    ).rejects.toThrow(/account_not_found/);

    // The foreign row is untouched, verified with the privileged connection.
    const after = await db.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [otherAccountId]);
    expect(after.rows[0].name).toBe("Their account");
  });

  it("cannot plant an account in another business by claiming its id", async () => {
    await expect(
      dbLib.withTenant(biz.id, () =>
        accountsService.createAccount({
          businessId: otherBizId,
          code: "7200",
          name: "planted",
          type: "asset",
        }),
      ),
    ).rejects.toThrow();

    const planted = await db.query("SELECT id FROM accounts WHERE business_id = $1 AND code = '7200'", [
      otherBizId,
    ]);
    expect(planted.rows).toHaveLength(0);
  });

  it("cannot read another business's audit trail", async () => {
    // A real audit row for the foreign tenant…
    await db.query(
      `INSERT INTO audit_log (business_id, action, entity, entity_id, payload)
       VALUES ($1, 'account.deleted', 'account', $2, '{"code":"7100"}'::jsonb)`,
      [otherBizId, otherAccountId],
    );
    const entries = await dbLib.withTenant(biz.id, () =>
      auditService.listAuditLog(biz.id, { limit: 200 }),
    );
    expect(entries.some((e) => e.entityId === otherAccountId)).toBe(false);
  });
});

describe("issue #824 review §6: a deleted account stays legible in the audit trail", () => {
  it("falls back to the snapshot's code and name once the account row is gone", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8800",
      name: "Short-lived",
      type: "expense",
      actorId: user.id,
    });
    await accountsService.deleteAccount(biz.id, id, user.id);

    // The row is genuinely gone…
    const gone = await db.query("SELECT 1 FROM accounts WHERE id = $1", [id]);
    expect(gone.rows).toHaveLength(0);

    // …but the trail still names it: `entity_name` is a live join, so without
    // the payload fallback this row would render as a blank in the history UI.
    const entries = await auditService.listAuditLog(biz.id, { limit: 50 });
    const deleted = entries.find((e) => e.action === "account.deleted" && e.entityId === id);
    expect(deleted).toBeTruthy();
    expect(deleted!.entityName).toBe("8800 — Short-lived");
  });

  it("uses the live row when it still exists, and the payload only as a fallback", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "8810",
      name: "Renamed later",
      type: "expense",
      actorId: user.id,
    });
    await accountsService.updateAccount({ businessId: biz.id, id, name: "Current name", actorId: user.id });

    const entries = await auditService.listAuditLog(biz.id, { limit: 50 });
    const renamed = entries.find((e) => e.action === "account.renamed" && e.entityId === id);
    expect(renamed!.entityName).toBe("8810 — Current name");
  });
});

describe("issue #824 review §7: reparent vs delete, and depth cascade under contention", () => {
  it("either moves the child or deletes the parent — never deletes a parent that still has one", async () => {
    const { id: parent } = await accountsService.createAccount({
      businessId: biz.id, code: "4600", name: "Contended parent", type: "expense",
    });
    const { id: child } = await accountsService.createAccount({
      businessId: biz.id, code: "4610", name: "Contended child", type: "expense", parentId: parent,
    });
    const { id: destination } = await accountsService.createAccount({
      businessId: biz.id, code: "4620", name: "Contended destination", type: "expense",
    });

    await Promise.allSettled([
      accountsService.reparentAccount(biz.id, child, destination),
      accountsService.deleteAccount(biz.id, parent, user.id),
    ]);

    // The invariant: a deleted parent cannot still have children, and a live
    // child cannot point at a deleted row (the FK is ON DELETE SET NULL, so
    // the schema alone would silently orphan it rather than refuse).
    const { rows } = await db.query<{ child_parent: string | null; parent_exists: boolean }>(
      `SELECT c.parent_id AS child_parent, EXISTS (SELECT 1 FROM accounts p WHERE p.id = c.parent_id) AS parent_exists
         FROM accounts c WHERE c.id = $1`,
      [child],
    );
    expect(rows[0].parent_exists).toBe(true);
    expect(rows[0].child_parent === destination || rows[0].child_parent === parent).toBe(true);

    const parentGone = await db.query("SELECT 1 FROM accounts WHERE id = $1", [parent]);
    if (parentGone.rows.length === 0) {
      // Deletion won — then the child must have moved off it first.
      expect(rows[0].child_parent).toBe(destination);
    }
  });

  it("keeps a deep subtree's levels consistent when a reparent races an archive", async () => {
    const { id: root } = await accountsService.createAccount({
      businessId: biz.id, code: "4700", name: "Depth root", type: "expense",
    });
    const { id: kol } = await accountsService.createAccount({
      businessId: biz.id, code: "4710", name: "Depth kol", type: "expense", parentId: root,
    });
    const { id: moein } = await accountsService.createAccount({
      businessId: biz.id, code: "4720", name: "Depth moein", type: "expense", parentId: kol,
    });
    const { id: destination } = await accountsService.createAccount({
      businessId: biz.id, code: "4730", name: "Depth destination", type: "expense",
    });

    await Promise.allSettled([
      accountsService.reparentAccount(biz.id, kol, destination),
      accountsService.setAccountActive(biz.id, moein, false),
    ]);

    // Whatever the interleaving, every descendant's stored level must be exactly
    // one tier below its parent's — the cascade is what reparent promises, and a
    // racing archive must not leave a half-cascaded tier behind.
    const { rows } = await db.query<{ code: string; level: string; parent_code: string | null }>(
      `SELECT c.code, c.level, p.code AS parent_code
         FROM accounts c LEFT JOIN accounts p ON p.id = c.parent_id
        WHERE c.id = ANY($1::uuid[])`,
      [[root, kol, moein, destination]],
    );
    const levelOf = new Map(rows.map((r) => [r.code, r.level]));
    const rank = { group: 0, kol: 1, moein: 2, tafsili: 3 } as const;
    for (const r of rows) {
      if (!r.parent_code) {
        expect(rank[r.level as keyof typeof rank]).toBe(0);
        continue;
      }
      const parentLevel = levelOf.get(r.parent_code)!;
      expect(rank[r.level as keyof typeof rank]).toBe(rank[parentLevel as keyof typeof rank] + 1);
    }
  });
});
